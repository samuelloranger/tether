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
