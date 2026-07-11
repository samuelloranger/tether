import { expect, test } from 'bun:test';
import { verifyPassword } from './auth';
import { getAuthHash, setAuthHash } from './db';

// Run with a fresh TETHER_DB_PATH so no hash pre-exists:
//   TETHER_DB_PATH=/tmp/tether-test-$$.db bun test src/server/auth.test.ts

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
