import { spawnSync } from 'node:child_process';
import path from 'node:path';

const MAX_DIFF_BYTES = 1_048_576;

export class GitDiffError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

export interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
}

function validatePath(requestedPath: string | undefined) {
  if (requestedPath === undefined) return;
  if (path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes('..')) {
    throw new GitDiffError(400, 'invalid file path');
  }
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_DIFF_BYTES + 65_536,
  });
  if (result.status !== 0) throw new GitDiffError(404, 'not a git repository');
  return result.stdout;
}

export function readDiffSummary(root: string): { files: DiffFileStat[] } {
  const out = runGit(root, ['diff', 'HEAD', '--numstat']);
  const files = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [insertions, deletions, filePath] = line.split('\t');
      return {
        path: filePath,
        insertions: insertions === '-' ? 0 : Number(insertions),
        deletions: deletions === '-' ? 0 : Number(deletions),
      };
    });
  return { files };
}

export function readDiff(root: string, requestedPath?: string): { diff: string; truncated: boolean } {
  validatePath(requestedPath);
  const args = ['diff', 'HEAD'];
  if (requestedPath) args.push('--', requestedPath);
  const out = runGit(root, args);
  if (out.length > MAX_DIFF_BYTES) return { diff: out.slice(0, MAX_DIFF_BYTES), truncated: true };
  return { diff: out, truncated: false };
}
