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

test('PATCH /api/config rejects private notification addresses unless explicitly allowed', async () => {
  const previous = getAuthHash();
  const previousAllowPrivate = process.env.TETHER_ALLOW_PRIVATE_NOTIFY_URL;
  setAuthHash(await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }));
  try {
    for (const url of [
      'http://127.0.0.1',
      'http://169.254.169.254',
      'http://10.0.0.1',
      'http://172.16.0.1',
      'http://192.168.1.1',
      'http://[fe80::1]',
      'http://[fc00::1]',
    ]) {
      const res = await app.request('/api/config', {
        method: 'PATCH',
        headers: AUTH,
        body: JSON.stringify({ notify: { url } }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('TETHER_ALLOW_PRIVATE_NOTIFY_URL=1');
    }

    process.env.TETHER_ALLOW_PRIVATE_NOTIFY_URL = '1';
    const allowed = await app.request('/api/config', {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ notify: { url: 'http://192.168.1.1' } }),
    });
    expect(allowed.status).toBe(200);
  } finally {
    setAuthHash(previous);
    if (previousAllowPrivate === undefined) delete process.env.TETHER_ALLOW_PRIVATE_NOTIFY_URL;
    else process.env.TETHER_ALLOW_PRIVATE_NOTIFY_URL = previousAllowPrivate;
  }
});
