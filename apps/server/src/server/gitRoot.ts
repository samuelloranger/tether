import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { HIDE_CONSOLE } from './spawnWindow';

// A session's cwd can stop existing while the shell still sits in it (worktree
// removed, rm -rf'd, branch switch). Ordinary state, not a 500.
export class GitRootError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'GitRootError';
  }
}

export function findGitRoot(cwd: string): string | null {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    ...HIDE_CONSOLE,
  });
  const top = result.status === 0 ? result.stdout.trim() : '';
  return top ? realpathSync(top) : null;
}

export function resolveGitDir(root: string): string {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8',
    ...HIDE_CONSOLE,
  });
  const gitDir = result.status === 0 ? result.stdout.trim() : '';
  if (!gitDir) throw new Error('not a git repository');
  return realpathSync(gitDir);
}

// Recomputed on every call — a session's cwd can point at a different project
// between requests (the user just `cd`'d), so nothing here is cached.
export function resolveGitRoot(cwd: string): string {
  const root = findGitRoot(cwd);
  if (root) return root;
  try {
    return realpathSync(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new GitRootError(409, 'working directory no longer exists');
    }
    throw error;
  }
}
