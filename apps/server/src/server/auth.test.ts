import { beforeAll, expect, test } from 'bun:test';

// Self-isolating: point the DB at a fresh temp file BEFORE importing ./db (which
// resolves its path at import time). Dynamic imports keep db.ts from loading — and
// touching the live server database — until the env is set. No caller env needed.
let getAuthHash: () => string | null;
let setAuthHash: (hash: string) => void;
let verifyPassword: (provided: string) => Promise<boolean>;

beforeAll(async () => {
  process.env.TETHER_DB_PATH = `/tmp/tether-authtest-${Date.now()}-${process.pid}.db`;
  const db = await import('./db');
  const auth = await import('./auth');
  getAuthHash = db.getAuthHash;
  setAuthHash = db.setAuthHash;
  verifyPassword = auth.verifyPassword;
});

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
