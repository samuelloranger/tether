import { afterEach, expect, spyOn, test } from 'bun:test';
import { resetAdminRateLimit } from './admin';
import { app } from './app';
import { countPushDevices, registerPushDevice, removePushDevice } from './pushDevices';
import { PUSH_RELAY_URL } from './pushRelay';
import { testAuthHeaders } from './testAuth';

afterEach(() => resetAdminRateLimit());

test('admin operations reject a missing or garbage token', async () => {
  for (const path of ['/api/admin/update', '/api/admin/restart'] as const) {
    const missing = await app.request(path, { method: 'POST' });
    expect(missing.status).toBe(401);
    const garbage = await app.request(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(garbage.status).toBe(401);
  }
});

const SECRET = Buffer.alloc(32, 7).toString('base64');

test('a test notification reaches every registered device', async () => {
  const AUTH = { ...testAuthHeaders(), 'Content-Type': 'application/json' };
  const previous = globalThis.fetch;
  const sent: Array<{ url: string; body: { token: string; ciphertext: string } }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  registerPushDevice('device-a', SECRET);
  try {
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
    globalThis.fetch = previous;
    removePushDevice('device-a');
  }
});

test('a test notification whose devices are all stale reports failure, not success', async () => {
  const AUTH = { ...testAuthHeaders(), 'Content-Type': 'application/json' };
  const previous = globalThis.fetch;
  const error = spyOn(console, 'error').mockImplementation(() => {});
  // 410 prunes the token and resolves. Counting settled promises would call
  // this a success and the settings screen would claim it sent something.
  globalThis.fetch = (async () => new Response(null, { status: 410 })) as unknown as typeof fetch;
  registerPushDevice('device-stale', SECRET);
  try {
    const res = await app.request('/api/admin/test-notification', {
      method: 'POST',
      headers: AUTH,
    });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('removed');
    expect(countPushDevices()).toBe(0);
  } finally {
    globalThis.fetch = previous;
    error.mockRestore();
    removePushDevice('device-stale');
  }
});

test('a test notification with no registered device says so instead of failing silently', async () => {
  const AUTH = { ...testAuthHeaders(), 'Content-Type': 'application/json' };
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await app.request('/api/admin/test-notification', {
      method: 'POST',
      headers: AUTH,
    });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('No devices are registered');
  } finally {
    error.mockRestore();
  }
});

test('test notification reports a delivery failure', async () => {
  const AUTH = { ...testAuthHeaders(), 'Content-Type': 'application/json' };
  const previous = globalThis.fetch;
  const error = spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  registerPushDevice('device-b', SECRET);
  try {
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
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.+ Test notification delivery failed:$/),
      expect.any(Error),
    );
  } finally {
    globalThis.fetch = previous;
    error.mockRestore();
    removePushDevice('device-b');
  }
});
