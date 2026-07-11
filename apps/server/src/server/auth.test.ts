import { expect, test } from 'bun:test';
import { verifyPassword } from './auth';
import { getAuthHash, setAuthHash } from './db';

// Isolation is guaranteed by test-preload.ts (bunfig.toml), which pins
// TETHER_DB_PATH to a temp file BEFORE any test file imports ./db — so this
// suite never touches the developer's live config database.

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
