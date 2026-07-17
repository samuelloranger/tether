import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export function findGitRoot(cwd: string): string | null {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  const top = result.status === 0 ? result.stdout.trim() : '';
  return top ? realpathSync(top) : null;
}

export function resolveGitDir(root: string): string {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8',
  });
  const gitDir = result.status === 0 ? result.stdout.trim() : '';
  if (!gitDir) throw new Error('not a git repository');
  return realpathSync(gitDir);
}

// Resolves the nearest git repository root containing `cwd`, or `cwd` itself
// if it isn't inside a git working tree. Recomputed on every call — a
// session's cwd can point at a different project between requests (the user
// just `cd`'d), so nothing here is cached.
export function resolveGitRoot(cwd: string): string {
  return findGitRoot(cwd) ?? realpathSync(cwd);
}
