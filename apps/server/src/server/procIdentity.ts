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
function windowsStartTime(pid: number): string | null {
  // Retried once. An empty answer is ambiguous — it means EITHER the pid is
  // gone (the documented case below) OR powershell.exe never got far enough to
  // answer, which happens on a cold start under load and made this return null
  // for a process that was plainly alive. The retry costs one extra spawn on
  // the genuinely-gone path, and the callers run this at most twice.
  return queryWindowsStartTime(pid) ?? queryWindowsStartTime(pid);
}

function queryWindowsStartTime(pid: number): string | null {
  try {
    const proc = Bun.spawnSync(
      [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`,
      ],
      HIDE_CONSOLE,
    );
    const out = proc.stdout.toString().trim();
    // A missing pid yields an empty string (SilentlyContinue swallows the
    // error and .Ticks on $null produces nothing) — same "gone" signal the
    // POSIX branches return null for.
    return /^\d+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
