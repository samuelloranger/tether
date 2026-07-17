import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

// Resolves the nearest git repository root containing `cwd`, or `cwd` itself
// if it isn't inside a git working tree. Recomputed on every call — a
// session's cwd can point at a different project between requests (the user
// just `cd`'d), so nothing here is cached.
export function resolveGitRoot(cwd: string): string {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  const top = result.status === 0 ? result.stdout.trim() : '';
  return realpathSync(top || cwd);
}
