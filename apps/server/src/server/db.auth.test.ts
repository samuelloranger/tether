import { expect, test } from 'bun:test';
import { getAuthHash, setAuthHash, setAuthHashIfUnset } from './db';

test('setAuthHashIfUnset writes only when unset', () => {
  setAuthHash(null);
  expect(setAuthHashIfUnset('hash-a')).toBe(true);
  expect(getAuthHash()).toBe('hash-a');
  expect(setAuthHashIfUnset('hash-b')).toBe(false);
  expect(getAuthHash()).toBe('hash-a');
  setAuthHash(null);
});
