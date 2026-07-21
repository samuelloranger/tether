import { expect, test } from 'bun:test';
import { hasControlToken } from './app';

test('hasControlToken returns false (no throw) for multibyte same-length input', () => {
  // Same string length as a hex token but different byte length must not throw.
  expect(() => hasControlToken('é'.repeat(64))).not.toThrow();
  expect(hasControlToken('é'.repeat(64))).toBe(false);
});

test('hasControlToken returns false for undefined', () => {
  expect(hasControlToken(undefined)).toBe(false);
});
