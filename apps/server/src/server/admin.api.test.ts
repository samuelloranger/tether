import { afterEach, expect, spyOn, test } from 'bun:test';
import { resetAdminRateLimit } from './admin';
import { app } from './app';
import { getAuthHash, setAuthHash } from './db';
import { countPushDevices, registerPushDevice, removePushDevice } from './pushDevices';
import { PUSH_RELAY_URL } from './pushRelay';

const PASSWORD = 'admin-api-password';
const AUTH = { Authorization: `Bearer ${PASSWORD}`, 'Content-Type': 'application/json' };

afterEach(() => resetAdminRateLimit());

test('admin operations reject an incorrect current password', async () => {
  const previous = getAuthHash();
  setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
  try {
    for (const [path, body] of [
      ['/api/admin/password', { current: 'wrong', next: 'new-password' }],
      ['/api/admin/update', { current: 'wrong' }],
      ['/api/admin/restart', { current: 'wrong' }],
    ] as const) {
      const res = await app.request(path, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    }
  } finally {
    setAuthHash(previous);
  }
});

const SECRET = Buffer.alloc(32, 7).toString('base64');

test('a test notification reaches every registered device without a password prompt', async () => {
  const hash = getAuthHash();
  const previous = globalThis.fetch;
  const sent: Array<{ url: string; body: { token: string; ciphertext: string } }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  registerPushDevice('device-a', SECRET);
  try {
    setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
    const res = await app.request('/api/admin/test-notification', {
      method: 'POST',
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${PUSH_RELAY_URL}/push`);
    expect(sent[0].body.token).toBe('device-a');
    // The relay must only ever see ciphertext — assert the plaintext wording
    // is not on the wire, not merely that a request happened.
    expect(JSON.stringify(sent[0].body)).not.toContain('working');
  } finally {
    setAuthHash(hash);
    globalThis.fetch = previous;
    removePushDevice('device-a');
  }
});

test('a test notification whose devices are all stale reports failure, not success', async () => {
  const hash = getAuthHash();
  const previous = globalThis.fetch;
  const error = spyOn(console, 'error').mockImplementation(() => {});
  // 410 prunes the token and resolves. Counting settled promises would call
  // this a success and the settings screen would claim it sent something.
  globalThis.fetch = (async () => new Response(null, { status: 410 })) as unknown as typeof fetch;
  registerPushDevice('device-stale', SECRET);
  try {
    setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
    const res = await app.request('/api/admin/test-notification', {
      method: 'POST',
      headers: AUTH,
    });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('removed');
    // The pruning itself must still have happened.
    expect(countPushDevices()).toBe(0);
  } finally {
    setAuthHash(hash);
    globalThis.fetch = previous;
    error.mockRestore();
    removePushDevice('device-stale');
  }
});

test('a test notification with no registered device says so instead of failing silently', async () => {
  const hash = getAuthHash();
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
    const res = await app.request('/api/admin/test-notification', {
      method: 'POST',
      headers: AUTH,
    });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('No devices are registered');
  } finally {
    setAuthHash(hash);
    error.mockRestore();
  }
});

test('test notification reports a delivery failure', async () => {
  const hash = getAuthHash();
  const previous = globalThis.fetch;
  const error = spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  registerPushDevice('device-b', SECRET);
  try {
    setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
    const res = await app.request('/api/admin/test-notification', {
      method: 'POST',
      headers: AUTH,
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'relay returned 503',
      code: 'notification_delivery_failed',
    });
    expect(error).toHaveBeenCalledWith('Test notification delivery failed:', expect.any(Error));
  } finally {
    setAuthHash(hash);
    globalThis.fetch = previous;
    error.mockRestore();
    removePushDevice('device-b');
  }
});
