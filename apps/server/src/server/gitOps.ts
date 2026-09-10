import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { MAX_DIFF_BYTES, readDiffSummary } from './gitDiff';
import { canRewriteHead, readRepoStatus } from './gitStatus';
import { HIDE_CONSOLE } from './spawnWindow';

// Same trust anchor as the read side — the session's live cwd resolved to its
// git root, a tree the shell user already fully controls.
export class GitOpsError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

function validatePath(requestedPath: string) {
  if (path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes('..')) {
    throw new GitOpsError(400, 'invalid file path');
  }
}

// Surfaces failures as 409 with git's own stderr — the client shows it
// verbatim (hooks, conflicts, nothing-staged all self-explain).
function runGit(root: string, args: string[], input?: string, okStatuses: number[] = [0]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: MAX_DIFF_BYTES + 65_536,
    ...HIDE_CONSOLE,
  });
  if (result.status === null) throw new GitOpsError(404, 'not a git repository');
  if (!okStatuses.includes(result.status)) {
    throw new GitOpsError(409, (result.stderr || result.stdout || 'git command failed').trim());
  }
  return result.stdout;
}

export function stagePath(root: string, requestedPath: string): void {
  validatePath(requestedPath);
  runGit(root, ['add', '--', requestedPath]);
}

export function unstagePath(root: string, requestedPath: string): void {
  validatePath(requestedPath);
  runGit(root, ['reset', '-q', 'HEAD', '--', requestedPath]);
}

// Splits a single-file unified diff into (header, hunks[]). The header is
// everything up to the first @@ line; each hunk runs to the next @@ or EOF.
function splitHunks(diff: string): { header: string; hunks: string[] } {
  const lines = diff.split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk === -1) return { header: diff, hunks: [] };
  const header = `${lines.slice(0, firstHunk).join('\n')}\n`;
  const hunks: string[] = [];
  let current: string[] = [];
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith('@@') && current.length) {
      hunks.push(`${current.join('\n')}\n`);
      current = [];
    }
    current.push(line);
  }
  if (current.length) hunks.push(current.join('\n').replace(/\n*$/, '\n'));
  return { header, hunks };
}

// Client only sends a hunk index into the server's own diff view, never patch
// content. Untracked files need `git diff --no-index` — plain `git diff` is empty for them.
function applyHunk(root: string, requestedPath: string, hunkIndex: number, reverse: boolean): void {
  validatePath(requestedPath);
  let diff: string;
  if (reverse) {
    diff = runGit(root, ['diff', '--cached', '--', requestedPath]);
  } else if (isTracked(root, requestedPath)) {
    diff = runGit(root, ['diff', '--', requestedPath]);
  } else {
    diff = runGit(
      root,
      ['diff', '--no-index', '--', '/dev/null', requestedPath],
      undefined,
      [0, 1],
    );
  }
  const { header, hunks } = splitHunks(diff);
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= hunks.length) {
    throw new GitOpsError(409, 'stale diff — refresh');
  }
  const patch = header + hunks[hunkIndex];
  const applyArgs = ['apply', '--cached', ...(reverse ? ['-R'] : []), '-'];
  runGit(root, applyArgs, patch);
}

export function stageHunk(root: string, requestedPath: string, hunkIndex: number): void {
  applyHunk(root, requestedPath, hunkIndex, false);
}

export function unstageHunk(root: string, requestedPath: string, hunkIndex: number): void {
  applyHunk(root, requestedPath, hunkIndex, true);
}

function isTracked(root: string, requestedPath: string): boolean {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '--error-unmatch', '--', requestedPath],
    {
      encoding: 'utf8',
      ...HIDE_CONSOLE,
    },
  );
  return result.status === 0;
}

// Destructive: the client must confirm before calling. Tracked files are
// restored from the index; untracked files are deleted from disk.
export function discardPath(root: string, requestedPath: string): void {
  validatePath(requestedPath);
  if (isTracked(root, requestedPath)) {
    runGit(root, ['checkout', '-q', '--', requestedPath]);
    return;
  }
  const target = path.join(root, requestedPath);
  if (!existsSync(target)) throw new GitOpsError(404, 'file not found');
  rmSync(target);
}

// Commit identity comes from the repo/global git config — when unset, git's
// own error surfaces as the 409 message; the app does not manage identity.
export function commitStaged(root: string, message: string, amend = false): void {
  if (!message.trim()) throw new GitOpsError(400, 'commit message required');
  if (amend) {
    const status = readRepoStatus(root);
    if (!canRewriteHead(status)) {
      throw new GitOpsError(409, 'cannot amend: HEAD is already on the remote tip');
    }
    runGit(root, ['commit', '--amend', '-m', message]);
    return;
  }
  runGit(root, ['commit', '-m', message]);
}

export function stageAll(root: string): void {
  runGit(root, ['add', '-A']);
}

export function unstageAll(root: string): void {
  runGit(root, ['reset', '-q', 'HEAD']);
}

/** Discard every unstaged path from the current summary. Client must confirm. */
export function discardAll(root: string): void {
  const { files } = readDiffSummary(root);
  for (const file of files) {
    if (file.staged === true) continue;
    discardPath(root, file.path);
  }
}

/** Soft-reset HEAD~1 when rewriting is allowed. Changes stay staged. */
export function undoLastCommit(root: string): void {
  const status = readRepoStatus(root);
  if (!canRewriteHead(status)) {
    throw new GitOpsError(409, 'cannot undo: HEAD is already on the remote tip');
  }
  // Need a parent — root commit cannot soft-reset.
  const parents = spawnSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], {
    encoding: 'utf8',
    ...HIDE_CONSOLE,
  });
  if (parents.status !== 0 || Number(parents.stdout.trim()) < 2) {
    throw new GitOpsError(409, 'cannot undo: no parent commit');
  }
  runGit(root, ['reset', '--soft', 'HEAD~1']);
}

/** Push current branch. Sets upstream to origin/HEAD when none exists. */
export function pushBranch(root: string): void {
  const status = readRepoStatus(root);
  if (status.upstream) {
    runGit(root, ['push']);
    return;
  }
  runGit(root, ['push', '-u', 'origin', 'HEAD']);
}

export interface LogEntry {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

const MAX_LOG = 200;

export function readLog(root: string, limit = 50): LogEntry[] {
  const n = Math.min(Math.max(1, Math.floor(limit)), MAX_LOG);
  const out = runGit(root, ['log', '--format=%H%x00%h%x00%an%x00%aI%x00%s', '-n', String(n)]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, author, date, subject] = line.split('\0');
      return { sha, shortSha, author, date, subject };
    });
}

const SHA_RE = /^[0-9a-f]{4,40}$/i;

// Patch for one commit against its first parent (root commits diff against the
// empty tree — `git show` handles both). Same size cap as the working-tree diff.
export async function readCommitDiff(
  root: string,
  sha: string,
  requestedPath?: string,
): Promise<{ diff: string; truncated: boolean }> {
  if (!SHA_RE.test(sha)) throw new GitOpsError(400, 'invalid commit sha');
  if (requestedPath !== undefined) validatePath(requestedPath);
  const args = [
    'show',
    sha,
    '--first-parent',
    '--format=',
    ...(requestedPath ? ['--', requestedPath] : []),
  ];
  const out = runGit(root, args);
  if (out.length > MAX_DIFF_BYTES) {
    return { diff: out.slice(0, MAX_DIFF_BYTES), truncated: true };
  }
  return { diff: out, truncated: false };
}
