import { spawnSync } from 'node:child_process';

// Why every child spawn in this server passes `windowsHide`.
//
// The daemon is started detached (main.ts), which on Windows means
// DETACHED_PROCESS: it owns no console. That is what we want for a background
// service — but it has a consequence for everything it spawns. When a process
// with no console starts a *console* application, Windows does not run it
// headless; it allocates a brand new console for it, and that console is
// visible. So each `git` the git features shell out to opens a console window,
// holds it for as long as git runs, and closes it on exit.
//
// One of those is a flicker. The problem is the rate: readRepoStatus alone runs
// four git commands, gitWatch re-reads the diff and status on every debounced
// filesystem event, and an actively-edited repository produces those
// continuously — so the user gets a stream of terminals opening and closing on
// their desktop for as long as tether is watching a repo they are working in.
//
// CREATE_NO_WINDOW is the flag that says "console application, but no window",
// and `windowsHide: true` is how both node:child_process and Bun.spawn set it.
// Note it does NOT stop a console being allocated — a conhost.exe still appears
// per child, which is why counting conhost processes is a misleading way to
// check this; it stops the console having a *window*.
//
// Spread into the options of every spawn rather than set per call site, so the
// reasoning lives in one place and a new spawn is a one-token change. Harmless
// on POSIX, where the field is simply ignored — hence no platform branch, which
// also keeps the option object's shape identical across platforms.
export const HIDE_CONSOLE = { windowsHide: true } as const;

// Why every *synchronous* child spawn also needs a deadline.
//
// spawnSync blocks the JS thread, so nothing running on the event loop can
// interrupt it — including bun:test's per-test timeout, which is just a timer.
// A child that never exits therefore has no ceiling short of the CI step's own
// cap: a powershell.exe caught stuck for 890s took its whole `bun test` worker
// with it, stranding every file still queued to that worker and reporting
// nothing at all. Raising test timeouts cannot fix that shape of hang; only a
// spawn-level deadline can, and only node:child_process offers one (Bun.spawnSync
// has no timeout option).
//
// Generous on purpose — this is a liveness bound, not a performance budget. git
// on a large repository is allowed to be slow; it is not allowed to be
// infinite. Every call site here already treats `status === null` as a failure,
// so a killed child surfaces as an error rather than truncated output parsed as
// if it were complete.
export const SPAWN_TIMEOUT_MS = 60_000;

// Kill a process and its whole descendant tree on Windows.
//
// A signal on Windows only ever terminates the one pid, leaving the shell's
// children (the build, the agent, the ssh) orphaned and running. `taskkill /T`
// walks the real parent/child tree the kernel tracks — the one thing here that
// matches the POSIX process-group kill. `/F` because an interactive shell will
// not close on the polite request either. Shared so the holder's PTY teardown
// and pty.ts's detached-holder fallback stay one implementation, not two.
// node:child_process rather than Bun.spawnSync for the timeout alone: this is on
// the session-teardown path, and a blocking spawn with no deadline would hang
// the kill instead of failing it.
export function killWindowsTree(pid: number): void {
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: SPAWN_TIMEOUT_MS,
      ...HIDE_CONSOLE,
    });
  } catch {}
}
