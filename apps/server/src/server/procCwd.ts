import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

// Reads a process's current working directory straight from the kernel —
// works regardless of what's in its foreground job (a shell sitting idle, a
// long-running TUI, nothing at all), unlike sniffing OSC 7 escape sequences
// out of its terminal output, which only updates on a prompt redraw.
export function getProcessCwd(pid: number): string | null {
  try {
    return realpathSync(`/proc/${pid}/cwd`);
  } catch {}
  try {
    const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
    });
    if (result.status === 0) {
      const line = result.stdout.split('\n').find((l) => l.startsWith('n'));
      if (line) return line.slice(1);
    }
  } catch {}
  return null;
}
