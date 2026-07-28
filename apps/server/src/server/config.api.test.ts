import { afterEach, expect, test } from 'bun:test';
import { app } from './app';
import { resetConfigCache } from './config';
import { db, getAuthHash, setAuthHash } from './db';

const PASSWORD = 'config-api-password';
const AUTH = { Authorization: `Bearer ${PASSWORD}`, 'Content-Type': 'application/json' };

afterEach(() => {
  db.query("DELETE FROM settings WHERE key LIKE 'config.%'").run();
  resetConfigCache();
});

test('GET and PATCH /api/config are authenticated, merged, and redact tokens', async () => {
  const previous = getAuthHash();
  setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
  try {
    expect((await app.request('/api/config')).status).toBe(401);
    const patched = await app.request('/api/config', {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ notify: { enabled: true, topic: 'tether-test', token: 'secret' } }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).notify).toEqual({
      enabled: true,
      url: 'https://ntfy.sh',
      topic: 'tether-test',
      hasToken: true,
    });
    const fetched = await app.request('/api/config', { headers: AUTH });
    expect((await fetched.json()).notify.hasToken).toBe(true);
  } finally {
    setAuthHash(previous);
  }
});
