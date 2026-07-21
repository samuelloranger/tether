import { expect, test } from 'bun:test';
import { processStartTime } from './procIdentity';

test('processStartTime returns a stable non-null value for our own pid', () => {
  const a = processStartTime(process.pid);
  const b = processStartTime(process.pid);
  expect(a).not.toBeNull();
  expect(a).toBe(b);
});

test('processStartTime returns null for an impossible pid', () => {
  expect(processStartTime(2 ** 31 - 1)).toBeNull();
});
