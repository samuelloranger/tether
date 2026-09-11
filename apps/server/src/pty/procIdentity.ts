import { readFileSync } from 'node:fs';

// A per-process identity token that changes if the PID is recycled. On Linux we
// read starttime (field 22 of /proc/<pid>/stat, clock ticks since boot). On
// other platforms we fall back to `ps -o lstart=`. Returns null if the pid is
// gone or unreadable.
export function processStartTime(pid: number): string | null {
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
