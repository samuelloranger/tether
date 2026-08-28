import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getProcessCwd, readWindowsProcessCwd } from './procCwd';

const IS_WINDOWS = process.platform === 'win32';

test.skipIf(IS_WINDOWS)("reads the current process's own cwd from the kernel", () => {
  expect(getProcessCwd(process.pid)).toBe(realpathSync(process.cwd()));
});

// Windows keeps a process's cwd in its PEB. There is no API for it, but there
// is an ABI: NtQueryInformationProcess + ReadProcessMemory get there without a
// native addon (see procCwd.ts). These tests are the thing that would catch a
// future Windows build moving one of those offsets — the failure mode is a
// confident wrong path, not a crash, so it has to be asserted against a
// directory we chose.
const spawned: { kill(): void }[] = [];
afterAll(() => {
  for (const proc of spawned) {
    try {
      proc.kill();
    } catch {}
  }
});

/** A live cmd.exe parked at its prompt in `cwd`, so it has one to be read. */
async function shellIn(cwd: string): Promise<{ pid: number; kill(): void }> {
  const proc = Bun.spawn(['cmd.exe'], {
    cwd,
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  spawned.push(proc);
  // cmd.exe has its cwd before it runs a single instruction (the loader writes
  // RTL_USER_PROCESS_PARAMETERS), but the pid is not queryable until the
  // process object exists.
  await Bun.sleep(300);
  return proc;
}

test.skipIf(!IS_WINDOWS)('reads another process’s cwd out of its PEB', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'tether-cwd-')));
  const shell = await shellIn(dir);
  try {
    expect(readWindowsProcessCwd(shell.pid)).toBe(dir);
    // cmd.exe is on the allowlist, so the gated entry point answers too.
    expect(getProcessCwd(shell.pid)).toBe(dir);
  } finally {
    // The shell holds `dir` open as its cwd, so it has to go first or the
    // removal fails with EBUSY.
    shell.kill();
    await Bun.sleep(150);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// The gate is the whole reason this file is not simply "read the PEB". A
// PowerShell session's PEB cwd never leaves the directory it started in, and
// holderCwd() in holder.ts prefers a kernel read over OSC 7 — so answering for
// an unmeasured program would freeze that session's git and file views. The
// test runner itself (bun.exe) stands in for "unmeasured": the raw read gets a
// real answer, the gated one declines.
test.skipIf(!IS_WINDOWS)('declines to answer for a program not known to track its cwd', () => {
  expect(readWindowsProcessCwd(process.pid)).toBe(realpathSync(process.cwd()));
  expect(getProcessCwd(process.pid)).toBeNull();
});

// Windows stores the cwd with a trailing separator ("C:\Users\x\"), which is
// stripped so the value compares equal to node:path output — except at a drive
// root, where the separator is part of the path.
test.skipIf(!IS_WINDOWS)('keeps the separator only where it is part of the path', async () => {
  const root = path.parse(process.cwd()).root;
  expect(getProcessCwd((await shellIn(root)).pid)).toBe(root);
  expect(readWindowsProcessCwd(process.pid)?.endsWith(path.sep)).toBe(false);
});

// A protected process (System, pid 4) refuses the handle with
// ERROR_ACCESS_DENIED. That is the documented limitation, and it must land as
// null rather than an exception: the holder calls this from its frame handler.
test.skipIf(!IS_WINDOWS)('degrades to null on a target it may not open', () => {
  expect(() => getProcessCwd(4)).not.toThrow();
  expect(getProcessCwd(4)).toBeNull();
  expect(readWindowsProcessCwd(4)).toBeNull();
});

test.skipIf(!IS_WINDOWS)('degrades to null for a nonsense pid instead of throwing', () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    expect(() => getProcessCwd(pid)).not.toThrow();
    expect(getProcessCwd(pid)).toBeNull();
    expect(readWindowsProcessCwd(pid)).toBeNull();
  }
});

// The raw reader is Windows-only by contract; on POSIX it must not try to
// dlopen anything.
test.skipIf(IS_WINDOWS)('the Windows PEB reader is inert off Windows', () => {
  expect(() => readWindowsProcessCwd(process.pid)).not.toThrow();
  expect(readWindowsProcessCwd(process.pid)).toBeNull();
});

test('returns null for a pid that does not exist', () => {
  expect(getProcessCwd(2_147_483_646)).toBeNull();
});
