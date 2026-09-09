import path from 'node:path';
import { HIDE_CONSOLE } from './spawnWindow';

// Discover directories git considers ignored under `root` (as absolute paths).
// This is async on purpose: spawning git synchronously can stall the event loop.
export async function listIgnoredDirs(root: string): Promise<Set<string>> {
  const process = Bun.spawn(
    [
      'git',
      '-C',
      root,
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '--no-empty-directory',
    ],
    { stdout: 'pipe', stderr: 'ignore', ...HIDE_CONSOLE },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  if (exitCode !== 0) return new Set();
  return new Set(
    stdout
      .split('\0')
      .filter(Boolean)
      .map((rel) => path.join(root, rel.replace(/\/$/, ''))),
  );
}

export function isEacces(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EACCES';
}
