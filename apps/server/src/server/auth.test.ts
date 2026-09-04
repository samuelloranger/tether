import { afterEach, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { authMiddleware, verifyPassword } from './auth';
import { db, getAuthHash, setAuthHash } from './db';
import { addDevice } from './deviceRegistry';
import { mintToken } from './deviceToken';

// Isolation is guaranteed by test-preload.ts (bunfig.toml), which pins
// TETHER_DB_PATH to a temp file BEFORE any test file imports ./db — so this
// suite never touches the developer's live config database.

afterEach(() => {
  setAuthHash(null);
  db.query('DELETE FROM auth_devices').run();
});

function pubkeyFill(byte: number): string {
  return Buffer.from(new Uint8Array(32).fill(byte)).toString('base64');
}

/** Tiny app so we invoke authMiddleware without the rest of the route table. */
function appWithAuth(): Hono {
  const h = new Hono();
  h.use('*', authMiddleware);
  h.get('/api/health', (c) => c.json({ ok: true }));
  h.get('/api/status', (c) => c.json({ public: true }));
  return h;
}

test('verifyPassword false when no hash set', async () => {
  expect(getAuthHash()).toBeNull();
  expect(await verifyPassword('anything')).toBe(false);
});

test('auth hash round-trips through settings', () => {
  setAuthHash('argon2-hash-placeholder');
  expect(getAuthHash()).toBe('argon2-hash-placeholder');
  setAuthHash('second');
  expect(getAuthHash()).toBe('second'); // upsert overwrites
});

test('verifyPassword true only for the set password', async () => {
  setAuthHash(await Bun.password.hash('hunter2', { algorithm: 'argon2id' }));
  expect(await verifyPassword('hunter2')).toBe(true);
  expect(await verifyPassword('wrong')).toBe(false);
});

test('authMiddleware: minted token for a known device passes', async () => {
  const device = addDevice({ label: 'phone', pubkey: pubkeyFill(1) });
  const token = mintToken(device.id);
  const res = await appWithAuth().request('/api/health', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('authMiddleware: tampered token is 401', async () => {
  const device = addDevice({ label: 'phone', pubkey: pubkeyFill(2) });
  const token = mintToken(device.id);
  const [payload, sig] = token.split('.');
  const sigBytes = Buffer.from(sig, 'base64url');
  sigBytes[0] ^= 0xff;
  const tampered = `${payload}.${sigBytes.toString('base64url')}`;
  const res = await appWithAuth().request('/api/health', {
    headers: { Authorization: `Bearer ${tampered}` },
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: 'auth' });
});

test('authMiddleware: a valid password still passes', async () => {
  setAuthHash(await Bun.password.hash('hunter2', { algorithm: 'argon2id' }));
  const res = await appWithAuth().request('/api/health', {
    headers: { Authorization: 'Bearer hunter2' },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('authMiddleware: a public path is exempt', async () => {
  const res = await appWithAuth().request('/api/status');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ public: true });
});
