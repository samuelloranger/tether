import { beforeEach, expect, test } from 'bun:test';
import { app } from './app';
import { setAuthHash } from './db';

beforeEach(() => setAuthHash(null));

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
