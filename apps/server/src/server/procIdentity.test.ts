import { expect, test } from 'bun:test';
import { processStartTime } from './procIdentity';

// What this can assert, and what it deliberately no longer does.
//
// On POSIX the answer is a file read, so "our own pid resolves" is a real
// property and is asserted outright. On Windows it is a powershell.exe cold
// start, and demanding a non-null answer there made CI gate on whether the
// runner could start an interpreter inside a deadline — a fact about the host's
// load, not about this code. It was the single most frequent server-windows
// failure, and no timeout value fixes it: 5s, 12s and 20s all lost under load,
// because the thing being raced is not our work.
//
// So the recycle-detection contract is what gets asserted on both platforms —
// the token is a digit string, and it is STABLE across calls for a live pid,
// which is the whole reason this function exists. Windows is allowed to answer
// null (too slow), and is not allowed to answer inconsistently or to throw.
// The cheap, deterministic halves — a gone pid, the no-spawn guarantee — are
// covered below and do gate.
test('processStartTime is stable and well-formed for our own pid', () => {
  const a = processStartTime(process.pid);
  const b = processStartTime(process.pid);
  if (process.platform !== 'win32') expect(a).not.toBeNull();
  for (const answer of [a, b]) if (answer !== null) expect(answer).toMatch(/^\d+$/);
  // Equality only when both answered. A null is "too slow", not a different
  // identity, and it is not cached — so a slow first call followed by a fast
  // second one is a legitimate (Windows-only) mismatch, and asserting through
  // it would just be the same flake wearing a different assertion.
  if (a !== null && b !== null) expect(a).toBe(b);
}, 20_000);

test('processStartTime returns null for an impossible pid', () => {
  expect(processStartTime(2 ** 31 - 1)).toBeNull();
});

// The budget, not the clock, is the subject: one cold powershell.exe spawn costs
// ~1s on an idle machine and this path used to pay two of them to conclude what
// signal 0 answers for free. 500ms cannot fit even one, so a regression that
// reintroduces the spawn fails here instead of on a contended CI runner.
test.skipIf(process.platform !== 'win32')(
  'a gone pid is resolved without spawning powershell',
  () => {
    const started = Date.now();
    expect(processStartTime(2 ** 31 - 1)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  },
);
