import { afterEach, expect, test } from 'bun:test';
import { resetAdminRateLimit } from './admin';
import { app } from './app';
import { getAuthHash, setAuthHash } from './db';

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

test('test notification accepts an optional notify override without a password prompt', async () => {
  const hash = getAuthHash();
  const previous = globalThis.fetch;
  const sent: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  try {
    setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
    const res = await app.request('/api/admin/test-notification', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        notify: { enabled: true, url: 'https://notify.example', topic: 'tether-test' },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toEqual([
      {
        url: 'https://notify.example/tether-test',
        body: {
          topic: 'tether-test',
          title: 'Tether test notification',
          message: 'Notifications from this Tether server are working.',
          tags: ['tether'],
          click: 'tether://',
        },
      },
    ]);
  } finally {
    setAuthHash(hash);
    globalThis.fetch = previous;
  }
});

test('test notification reports a delivery failure', async () => {
  const hash = getAuthHash();
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  try {
    setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
    const res = await app.request('/api/admin/test-notification', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        notify: { enabled: true, url: 'https://notify.example', topic: 'tether-test' },
      }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'ntfy returned 503' });
  } finally {
    setAuthHash(hash);
    globalThis.fetch = previous;
  }
});
