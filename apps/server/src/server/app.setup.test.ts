import { afterEach, beforeEach, expect, test } from 'bun:test';
import { app } from './app';
import { setAuthHash } from './db';
import { VERSION } from './runtime';

beforeEach(() => setAuthHash(null));
// Reset after each too: these tests share the DB with the rest of the suite, so
// a left-behind hash would fail auth.test's "no hash set" case when ordered after.
afterEach(() => setAuthHash(null));

test('setup rejects a cross-site Origin', async () => {
  const res = await app.request('/api/setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
      Host: '127.0.0.1:8085',
    },
    body: JSON.stringify({ password: 'pw' }),
  });
  expect(res.status).toBe(403);
});

test('setup allows a same-origin loopback request', async () => {
  const res = await app.request('/api/setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:8085',
      Host: '127.0.0.1:8085',
    },
    body: JSON.stringify({ password: 'pw' }),
  });
  expect(res.status).toBe(200);
});

test('setup allows a native client (no Origin header)', async () => {
  const res = await app.request('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: '192.168.1.50:8085' },
    body: JSON.stringify({ password: 'pw' }),
  });
  expect(res.status).toBe(200);
});

test('health exposes the running server version after reconnect', async () => {
  setAuthHash(await Bun.password.hash('pw', { algorithm: 'argon2id' }));
  const res = await app.request('/api/health', { headers: { Authorization: 'Bearer pw' } });
  expect(await res.json()).toEqual({ ok: true, version: VERSION });
});
