import { afterAll, expect, test } from 'bun:test';
import { childPids, foregroundWantsInterrupt, interruptForeground } from './winConsole';

const IS_WINDOWS = process.platform === 'win32';

// The interesting behaviour needs a live ConPTY and is covered end-to-end by
// the PTY tests. What is pinned here is that every failure path degrades to
// "do nothing" instead of throwing — this runs inside the holder's input
// handler, where an exception would take the session's keystrokes down with it.

test('a pid that cannot be a console owner yields no answer, and does not throw', () => {
  expect(() => foregroundWantsInterrupt(2_147_483_646)).not.toThrow();
  expect(foregroundWantsInterrupt(2_147_483_646)).toBeNull();
});

test('interruptForeground reports "unknown" rather than killing anything on a bad pid', () => {
  expect(interruptForeground(2_147_483_646)).toBe('unknown');
});

// The console dance is only safe in a process that owns no console: attaching
// elsewhere means detaching from your own first. The test runner normally has
// one (or, in CI, none — either way nothing may be stolen), so this must be
// inert here regardless of platform.
test('never steals the console of the process it runs in', () => {
  const before = interruptForeground(process.pid);
  expect(['unknown', 'raw', 'idle', 'interrupted']).toContain(before);
  // Still able to talk to our own stdout afterwards — if the console had been
  // taken, writing would be the thing that broke.
  expect(() => process.stdout.write('')).not.toThrow();
});

// childPids is a hand-rolled read of PROCESSENTRY32W, so its correctness rests
// on a struct size and two offsets that no compiler is checking. A wrong offset
// reads a plausible number rather than failing, which is exactly why this is
// asserted against a child we spawned ourselves rather than against a shape.
const spawned: { kill(): void }[] = [];
afterAll(() => {
  for (const proc of spawned) {
    try {
      proc.kill();
    } catch {}
  }
});

test.skipIf(!IS_WINDOWS)('finds a spawned child among this process’s children', async () => {
  const child = Bun.spawn(['cmd.exe'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  spawned.push(child);
  await Bun.sleep(300);
  const children = childPids(process.pid);
  expect(children).toContain(child.pid);
  // Every entry is a real pid, not a field read from the wrong offset.
  for (const pid of children) expect(Number.isInteger(pid) && pid > 0).toBe(true);
  child.kill();
});

test.skipIf(!IS_WINDOWS)('returns an empty list for a pid nothing is parented to', () => {
  expect(childPids(2_147_483_646)).toEqual([]);
});

// It replaced a ~1.4s PowerShell spawn on the holder's keystroke path, so being
// merely correct is not enough. The bound is loose on purpose (the snapshot is
// O(processes) and CI machines vary); it is there to catch a regression back to
// spawning a shell, which is two orders of magnitude away.
test.skipIf(!IS_WINDOWS)('enumerates without spawning anything', () => {
  childPids(process.pid);
  const started = performance.now();
  for (let i = 0; i < 5; i++) childPids(process.pid);
  expect((performance.now() - started) / 5).toBeLessThan(500);
});

// Off Windows there is no kernel32 to open. That has to be a quiet empty list,
// not a throw: the same latch serves foregroundWantsInterrupt, and this is all
// reached from the holder's input handler.
test.skipIf(IS_WINDOWS)('degrades to an empty list where kernel32 does not exist', () => {
  expect(() => childPids(process.pid)).not.toThrow();
  expect(childPids(process.pid)).toEqual([]);
});

// Orphaned processes carry parent pid 0, so a caller that passed 0 (or a
// non-pid) must not be handed a list of unrelated processes to kill.
test('never treats 0 or a non-pid as a parent', () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) expect(childPids(pid)).toEqual([]);
});
