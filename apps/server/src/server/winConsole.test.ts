import { afterAll, expect, test } from 'bun:test';
import {
  childPids,
  consoleProcessPids,
  foregroundChildren,
  foregroundWantsInterrupt,
  interruptForeground,
} from './winConsole';

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
  const had = consoleProcessPids();
  const before = interruptForeground(process.pid);
  expect(['unknown', 'raw', 'idle', 'background', 'interrupted']).toContain(before);
  // Still able to talk to our own stdout afterwards — if the console had been
  // taken, writing would be the thing that broke.
  expect(() => process.stdout.write('')).not.toThrow();
  // …and the console itself is still ours. Under a pseudoconsole stdout is a
  // pipe and survives either way, so writing alone does not catch a FreeConsole
  // — this is the assertion that does.
  expect(consoleProcessPids()).toEqual(had);
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

/** A cmd.exe we own. `share` decides whether it joins our console or gets one. */
function spawnChild(share: boolean) {
  const child = Bun.spawn(['cmd.exe'], {
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
    // windowsHide is CREATE_NO_WINDOW, which is in the same mutually exclusive
    // group as CREATE_NEW_CONSOLE: the child gets a console of its own, without
    // a window. That is the same shape as a background job launched detached,
    // and it is what makes this a real include/exclude pair rather than two
    // spellings of the same spawn.
    ...(share ? {} : { windowsHide: true }),
  });
  spawned.push(child);
  return child;
}

/** Whether `pid` joins this process's console roster, within a short window. */
async function waitForConsoleMember(pid: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    if (consoleProcessPids().includes(pid)) return true;
    await Bun.sleep(100);
  }
  return false;
}

/** Both pids visible as our children, or give up — spawning is not instant. */
async function waitForChildren(pids: number[]) {
  for (let i = 0; i < 30; i++) {
    const children = childPids(process.pid);
    if (pids.every((pid) => children.includes(pid))) return children;
    await Bun.sleep(100);
  }
  return childPids(process.pid);
}

test.skipIf(!IS_WINDOWS)('finds a spawned child among this process’s children', async () => {
  const child = spawnChild(true);
  const children = await waitForChildren([child.pid]);
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
  expect(() => consoleProcessPids()).not.toThrow();
  expect(consoleProcessPids()).toEqual([]);
});

// Orphaned processes carry parent pid 0, so a caller that passed 0 (or a
// non-pid) must not be handed a list of unrelated processes to kill.
test('never treats 0 or a non-pid as a parent', () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) expect(childPids(pid)).toEqual([]);
});

// The narrowing that keeps a ^C off the user's background jobs. It is a pure
// intersection, so the platform-independent half is worth pinning on its own.
test('foregroundChildren keeps only the children on the console', () => {
  expect(foregroundChildren([10, 20, 30], [99, 20, 10])).toEqual([10, 20]);
  // No roster means no evidence, and evidence is what licenses a kill.
  expect(foregroundChildren([10, 20], [])).toEqual([]);
  expect(foregroundChildren([], [10])).toEqual([]);
});

// A console always lists its own attached readers, so this must never be empty
// where one exists — interruptForeground relies on that to tell a failed query
// apart from a deserted console, and treats the empty case as "kill nothing".
const HAS_CONSOLE = IS_WINDOWS && consoleProcessPids().length > 0;

test.skipIf(!HAS_CONSOLE)('lists this process among its own console clients', () => {
  expect(consoleProcessPids()).toContain(process.pid);
});

// The point of the whole exercise: a ^C for the foreground command must not
// take down a job that was started detached. The two children below differ only
// in whether they share this process's console, which is precisely the
// discriminator GetConsoleProcessList gives us.
test.skipIf(!HAS_CONSOLE)(
  'selects the console-sharing child and not the detached one',
  async () => {
    const shared = spawnChild(true);
    const detached = spawnChild(false);
    const children = await waitForChildren([shared.pid, detached.pid]);
    // Both really are our children — otherwise the exclusion below would pass for
    // the wrong reason, and the test would be pinning nothing at all.
    expect(children).toContain(shared.pid);
    expect(children).toContain(detached.pid);

    // Console membership is not instant, and on some hosts it never happens at
    // all: a GitHub Actions runner has a console by GetConsoleProcessList's
    // reckoning, yet a child spawned to share it does not join the roster the
    // way it does under a real terminal. Poll for the precondition instead of
    // assuming it.
    const joined = await waitForConsoleMember(shared.pid);
    const foreground = foregroundChildren(children, consoleProcessPids());

    // The regression guard, asserted unconditionally because it is the bug this
    // whole change exists to fix: a detached background job is never selected,
    // so a ^C for the foreground command cannot take it down. This holds whether
    // or not the host lets the other child join the console — an empty roster
    // selects nothing, which is also the safe answer.
    expect(foreground).not.toContain(detached.pid);

    // The inclusion half needs a host that actually shares consoles with
    // children. Where it does, a ^C must still reach the foreground command —
    // narrowing that killed nothing would be its own bug.
    if (joined) {
      expect(foreground).toContain(shared.pid);
    } else {
      console.warn(
        'winConsole: host does not propagate console membership to children; ' +
          'asserted the exclusion half only',
      );
    }

    shared.kill();
    detached.kill();
  },
);
