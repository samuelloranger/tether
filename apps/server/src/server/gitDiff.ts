import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const MAX_DIFF_BYTES = 1_048_576;

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
]);

export function isImagePath(requestedPath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(requestedPath).toLowerCase());
}

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
  binary: boolean;
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

function runGit(root: string, args: string[], okStatuses: number[] = [0]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_DIFF_BYTES + 65_536,
  });
  if (result.status === null || !okStatuses.includes(result.status)) {
    throw new GitDiffError(404, 'not a git repository');
  }
  return result.stdout;
}

function runGitDiff(root: string, args: string[], okStatuses: number[] = [0]): Promise<Buffer> {
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
      if (status === null || !okStatuses.includes(status)) {
        reject(new GitDiffError(404, 'not a git repository'));
      } else resolve(Buffer.concat(chunks));
    });
  });
}

// `git diff --no-index` exits 1 (not 0) when the two sides differ — that's
// the expected case every time we use it (comparing /dev/null against a real
// untracked file), so 1 is accepted alongside 0 wherever it's invoked.
const NO_INDEX_OK_STATUSES = [0, 1];

// Parses `--numstat -z` output (tracked-diff or --no-index). NUL-delimited so
// renames are unambiguous: a rename record is an empty inline path followed by
// two more NUL-terminated fields (old path, new path) instead of `old => new`
// baked into one string — see git-diff-tree(1) `-z` docs.
function parseNumstatZ(out: string): Array<{
  insertions: number;
  deletions: number;
  binary: boolean;
  path: string;
  oldPath?: string;
}> {
  const tokens = out.split('\0');
  if (tokens.length && tokens[tokens.length - 1] === '') tokens.pop();
  const records: Array<{
    insertions: number;
    deletions: number;
    binary: boolean;
    path: string;
    oldPath?: string;
  }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const [insertions, deletions, inlinePath] = tokens[i].split('\t');
    // git reports "-\t-\tpath" (instead of numeric counts) for binary files.
    const stat = {
      insertions: insertions === '-' ? 0 : Number(insertions),
      deletions: deletions === '-' ? 0 : Number(deletions),
      binary: insertions === '-' && deletions === '-',
    };
    if (inlinePath) {
      records.push({ ...stat, path: inlinePath });
    } else {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      records.push({ ...stat, path: newPath, oldPath });
    }
  }
  return records;
}

function listUntrackedFiles(root: string): string[] {
  const out = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean);
}

function isTracked(root: string, requestedPath: string): boolean {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '--error-unmatch', '--', requestedPath],
    {
      encoding: 'utf8',
    },
  );
  return result.status === 0;
}

function untrackedNumstat(root: string, requestedPath: string): DiffFileStat {
  const out = runGit(
    root,
    ['diff', '--no-index', '--numstat', '-z', '--', '/dev/null', requestedPath],
    NO_INDEX_OK_STATUSES,
  );
  const [record] = parseNumstatZ(out);
  return {
    path: requestedPath,
    insertions: record?.insertions ?? 0,
    deletions: record?.deletions ?? 0,
    binary: record?.binary ?? false,
  };
}

export function readDiffSummary(root: string): DiffSummary {
  const out = runGit(root, ['diff', 'HEAD', '--numstat', '-z']);
  const tracked = parseNumstatZ(out).map(({ insertions, deletions, binary, path }) => ({
    path,
    insertions,
    deletions,
    binary,
  }));
  const untracked = listUntrackedFiles(root).map((p) => untrackedNumstat(root, p));
  return { files: [...tracked, ...untracked] };
}

export async function readDiff(
  root: string,
  requestedPath?: string,
): Promise<{ diff: string; truncated: boolean }> {
  validatePath(requestedPath);

  if (!requestedPath) {
    const tracked = await runGitDiff(root, ['diff', 'HEAD']);
    const untrackedChunks = await Promise.all(
      listUntrackedFiles(root).map((p) =>
        runGitDiff(root, ['diff', '--no-index', '--', '/dev/null', p], NO_INDEX_OK_STATUSES),
      ),
    );
    const out = Buffer.concat([tracked, ...untrackedChunks]);
    if (out.length > MAX_DIFF_BYTES)
      return { diff: out.subarray(0, MAX_DIFF_BYTES).toString('utf8'), truncated: true };
    return { diff: out.toString('utf8'), truncated: false };
  }

  let out: Buffer;
  if (isTracked(root, requestedPath)) {
    const renameRecord = parseNumstatZ(runGit(root, ['diff', 'HEAD', '--numstat', '-z'])).find(
      (r) => r.path === requestedPath && r.oldPath,
    );
    const pathArgs = renameRecord?.oldPath
      ? ['--', renameRecord.oldPath, requestedPath]
      : ['--', requestedPath];
    out = await runGitDiff(root, ['diff', 'HEAD', ...pathArgs]);
  } else {
    out = await runGitDiff(
      root,
      ['diff', '--no-index', '--', '/dev/null', requestedPath],
      NO_INDEX_OK_STATUSES,
    );
  }
  if (out.length > MAX_DIFF_BYTES)
    return { diff: out.subarray(0, MAX_DIFF_BYTES).toString('utf8'), truncated: true };
  return { diff: out.toString('utf8'), truncated: false };
}

// Raw bytes for one side of a (possibly binary) file, for image-diff previews.
// 'old' reads the committed blob via `git show`; 'new' reads the working tree
// directly. Either side legitimately doesn't exist (added or deleted file) —
// that's not an error, just null, so the caller can render a one-sided view.
export function readDiffBlob(
  root: string,
  side: 'old' | 'new',
  requestedPath: string,
): Buffer | null {
  validatePath(requestedPath);
  if (side === 'new') {
    const canonicalRoot = realpathSync(root);
    let file: string;
    try {
      file = realpathSync(path.resolve(canonicalRoot, requestedPath));
    } catch {
      return null;
    }
    if (file !== canonicalRoot && !file.startsWith(`${canonicalRoot}${path.sep}`)) return null;
    try {
      return readFileSync(file);
    } catch {
      return null;
    }
  }
  const result = spawnSync('git', ['-C', root, 'show', `HEAD:${requestedPath}`], {
    maxBuffer: MAX_DIFF_BYTES + 65_536,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}
