import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { HIDE_CONSOLE } from './spawnWindow';

// A per-process identity token that changes if the PID is recycled. On Linux we
// read starttime (field 22 of /proc/<pid>/stat, clock ticks since boot). On
// other platforms we fall back to `ps -o lstart=`. Returns null if the pid is
// gone or unreadable.
export function processStartTime(pid: number): string | null {
  if (process.platform === 'win32') return windowsStartTime(pid);
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm (field 2) may contain spaces/parens; split after the last ')'.
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // Fields from field 3 onward live at index 0; starttime is field 22 =>
      // index 22 - 3 = 19.
      const starttime = after[19];
      return starttime ?? null;
    } catch {
      return null;
    }
  }
  try {
    const out = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)])
      .stdout.toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

// Windows has neither /proc nor `ps`. Get-Process exposes the creation time as
// .NET ticks, which is exactly the stable, PID-recycle-detecting token we want.
// `-NoProfile` matters for more than speed here: a user profile that prints a
// banner would corrupt the value we parse back out.
//
// Deliberately spawns PowerShell rather than reading Win32_Process over CIM —
// same information, ~5x cheaper (roughly 270ms vs 1.4s). Still far too slow for
// a hot path, which is fine: the only callers are the daemon's start/stop/status
// control commands (main.ts), each of which runs this at most twice.
// A process's start time never changes while it is alive, so a successful
// answer is cached for the life of THIS process. That collapses repeat lookups
// of the same pid — the daemon polling its own recorded pid across start/stop/
// status — from several cold powershell.exe spawns to none, which on a
// contended Windows CI runner is the difference between finishing inside the
// test budget and timing out. Only non-null answers are cached: a "gone" pid
// must stay re-queryable, and caching a live pid's null would freeze one slow
// interpreter start into a permanently wrong answer.
const startTimeCache = new Map<number, string>();

// Is `pid` gone, cheaply? An empty answer from powershell.exe used to be
// ambiguous — gone, or just too slow — and the old retry paid a second cold
// spawn to guess. Signal 0 settles it for ~2µs and no subprocess: ESRCH is the
// only answer that means "not there". EPERM means the process exists and is
// merely protected (pid 4, System), which is alive.
function definitelyGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function windowsStartTime(pid: number): string | null {
  const cached = startTimeCache.get(pid);
  if (cached !== undefined) return cached;
  // A gone pid answers empty no matter how long powershell.exe is given, so
  // asking it at all was two cold spawns spent confirming what the kernel
  // already knows. Ask the kernel first.
  if (definitelyGone(pid)) return null;
  // One patient attempt, not two impatient ones. The retry this replaces existed
  // because a cold powershell.exe under load answered empty for a process that
  // was plainly alive — but a second cold start races the same contention and
  // is no likelier to win it, and paying two of them is what pushed this past
  // the test budget. Now that a dead pid never reaches here, an empty answer
  // means only "too slow", and the fix for too slow is a longer single deadline.
  const answer = queryWindowsStartTime(pid);
  if (answer !== null) startTimeCache.set(pid, answer);
  return answer;
}

// A powershell.exe that never finishes starting is not a hypothetical: one was
// caught 890 seconds into a `bun test` worker with the run's other 47 files
// still queued behind it. spawnSync blocks the JS thread, so bun's per-test
// timeout — a timer on the event loop that blocking call owns — can never fire;
// nothing below the CI step's own cap bounds it. That is why raising test
// timeouts never fixed the server-windows hang. A spawn-level timeout is the
// only thing that can, and it must come from node:child_process: Bun.spawnSync
// has no equivalent.
//
// Sized to be the single attempt's whole budget: generous enough that a cold
// interpreter on a loaded runner still answers (measured at ~1s idle, and two
// 5s attempts were not enough under a deliberately starved 20-worker run),
// while leaving room under the caller's own 20s ceiling.
const POWERSHELL_TIMEOUT_MS = 12_000;

function queryWindowsStartTime(pid: number): string | null {
  try {
    const proc = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`,
      ],
      { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, ...HIDE_CONSOLE },
    );
    const out = (proc.stdout ?? '').trim();
    // A missing pid yields an empty string (SilentlyContinue swallows the
    // error and .Ticks on $null produces nothing) — same "gone" signal the
    // POSIX branches return null for. A killed-on-timeout child lands here too.
    return /^\d+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
