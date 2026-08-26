import { afterEach, expect, spyOn, test } from 'bun:test';
import { resetAdminRateLimit } from './admin';
import { app } from './app';
import { getAuthHash, setAuthHash } from './db';

const PASSWORD = 'rate-limit-test-password';
const AUTH = { Authorization: `Bearer ${PASSWORD}`, 'Content-Type': 'application/json' };

afterEach(() => resetAdminRateLimit());

async function withAuth(fn: () => Promise<void>): Promise<void> {
  const previous = getAuthHash();
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
    await fn();
  } finally {
    setAuthHash(previous);
    error.mockRestore();
  }
}

test('admin rate limit ignores spoofed X-Forwarded-For — same peer shares one bucket', async () => {
  await withAuth(async () => {
    const peer = { peerAddress: '203.0.113.10' };
    for (let i = 0; i < 5; i++) {
      const res = await app.request(
        '/api/admin/test-notification',
        {
          method: 'POST',
          headers: { ...AUTH, 'X-Forwarded-For': `198.51.100.${i}` },
        },
        peer,
      );
      expect(res.status).not.toBe(429);
    }
    const limited = await app.request(
      '/api/admin/test-notification',
      {
        method: 'POST',
        headers: { ...AUTH, 'X-Forwarded-For': '203.0.113.99' },
      },
      peer,
    );
    expect(limited.status).toBe(429);
  });
});

test('admin rate limit buckets separately for different peer addresses', async () => {
  await withAuth(async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.request(
        '/api/admin/test-notification',
        { method: 'POST', headers: AUTH },
        { peerAddress: '203.0.113.1' },
      );
      expect(res.status).not.toBe(429);
    }
    const blocked = await app.request(
      '/api/admin/test-notification',
      { method: 'POST', headers: AUTH },
      { peerAddress: '203.0.113.1' },
    );
    expect(blocked.status).toBe(429);

    const otherPeer = await app.request(
      '/api/admin/test-notification',
      { method: 'POST', headers: AUTH },
      { peerAddress: '203.0.113.2' },
    );
    expect(otherPeer.status).not.toBe(429);
  });
});
