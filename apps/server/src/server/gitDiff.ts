import { spawn, spawnSync } from 'node:child_process';
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

export interface DiffSummary {
  files: DiffFileStat[];
}

export const EMPTY_DIFF_SUMMARY: DiffSummary = { files: [] };

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

function runGitDiff(root: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args]);
    const chunks: Buffer[] = [];
    let length = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = MAX_DIFF_BYTES + 1 - length;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        length += kept.length;
      }
    });
    child.stderr.resume();
    child.on('error', () => reject(new GitDiffError(404, 'not a git repository')));
    child.on('close', (status) => {
      if (status !== 0) reject(new GitDiffError(404, 'not a git repository'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export function readDiffSummary(root: string): DiffSummary {
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

export async function readDiff(
  root: string,
  requestedPath?: string,
): Promise<{ diff: string; truncated: boolean }> {
  validatePath(requestedPath);
  const args = ['diff', 'HEAD'];
  if (requestedPath) args.push('--', requestedPath);
  const out = await runGitDiff(root, args);
  if (out.length > MAX_DIFF_BYTES)
    return { diff: out.subarray(0, MAX_DIFF_BYTES).toString('utf8'), truncated: true };
  return { diff: out.toString('utf8'), truncated: false };
}
