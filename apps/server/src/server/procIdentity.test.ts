import { expect, test } from 'bun:test';
import { processStartTime } from './procIdentity';

// The 20s timeout: on Windows this shells out to process enumeration
// (WMIC/PowerShell), slow enough on a contended CI runner to blow bun's 5000ms
// default. Harmless elsewhere — the probe answers in microseconds.
test('processStartTime returns a stable non-null value for our own pid', () => {
  const a = processStartTime(process.pid);
  const b = processStartTime(process.pid);
  expect(a).not.toBeNull();
  expect(a).toBe(b);
}, 20_000);

test('processStartTime returns null for an impossible pid', () => {
  expect(processStartTime(2 ** 31 - 1)).toBeNull();
});
