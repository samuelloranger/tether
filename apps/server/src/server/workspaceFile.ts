import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { toWorkspacePath } from './workspacePath';

const MAX_TEXT_BYTES = 1_048_576;

const IS_WINDOWS = process.platform === 'win32';

/**
 * Resolve a path to the one spelling every containment check in this module
 * compares against.
 *
 * `realpathSync` follows symlinks on both platforms, but on Windows that is only
 * half the job: it leaves 8.3 short names and letter case exactly as they were
 * handed in, so the same directory comes back as `C:\Users\sam\p`,
 * `c:\users\sam\p` or `C:\Users\SAMUEL~1.LOR\p` depending purely on how the
 * caller spelled it. `realpathSync.native` goes through the OS and returns the
 * long, on-disk-cased form for all three. (test-paths.ts documents the same
 * divergence from the fixture side.)
 *
 * That matters here because the workspace root and the requested file arrive
 * from different places — the root from git, the cwd from the shell's OSC 7, the
 * requested path from the client — and a containment check between two different
 * spellings of one directory is not a check at all.
 *
 * POSIX stays on plain `realpathSync`: there is no short-name or case
 * normalisation to do, and `.native` there is the same call by another name.
 */
export function canonicalPath(target: string): string {
  return IS_WINDOWS ? realpathSync.native(target) : realpathSync(target);
}

/**
 * Are two canonical paths the same path?
 *
 * Case-insensitive on Windows, case-SENSITIVE on POSIX. The asymmetry is the
 * whole point: on POSIX `/srv/Secret` and `/srv/secret` are two different
 * directories, and folding case there would let one be mistaken for the other —
 * a real weakening. On Windows they are one directory, and NOT folding is what
 * causes trouble.
 *
 * Folding on Windows cannot turn a denial into an escape. Both operands come
 * from `canonicalPath`, so they name real filesystem objects; two spellings that
 * differ only in case therefore denote the same object, because that is what
 * case-insensitivity means. Comparing them equal states a fact about the volume
 * rather than relaxing a rule.
 *
 * `toLowerCase`, not `toLocaleLowerCase`: the latter would apply the host's
 * locale, and under a Turkish locale would fold 'I' to 'ı' and stop matching
 * NTFS's own case table.
 */
export function samePath(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Is `value` the workspace root itself, or somewhere beneath it?
 *
 * The separator is required rather than a bare `startsWith`, so a sibling named
 * `/srv/workspace-evil` is not read as being inside `/srv/workspace`.
 *
 * Both arguments must already have been through `canonicalPath`; comparing a
 * canonical root against a raw request is how a traversal gets through.
 */
export function inside(root: string, value: string): boolean {
  const r = IS_WINDOWS ? root.toLowerCase() : root;
  const v = IS_WINDOWS ? value.toLowerCase() : value;
  return v === r || v.startsWith(`${r}${path.sep}`);
}

export class WorkspaceFileError extends Error {
  constructor(
    // 409 is the directory-listing case: the path was swapped between the
    // containment check and the read, so the result is discarded.
    readonly status: 400 | 404 | 409 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

export function readWorkspaceFile(root: string, requestedPath: string, cwd?: string) {
  if (
    !requestedPath ||
    path.isAbsolute(requestedPath) ||
    requestedPath.split(/[\\/]/).includes('..')
  )
    throw new WorkspaceFileError(400, 'invalid file path');
  const canonicalRoot = canonicalPath(root);
  let base = canonicalRoot;
  if (cwd) {
    try {
      base = canonicalPath(cwd);
    } catch {
      throw new WorkspaceFileError(400, 'invalid working directory');
    }
    if (!inside(canonicalRoot, base))
      throw new WorkspaceFileError(400, 'working directory escapes workspace');
  }
  let file: string;
  try {
    file = canonicalPath(path.resolve(base, requestedPath));
  } catch {
    throw new WorkspaceFileError(404, 'file not found');
  }
  if (!inside(canonicalRoot, file)) throw new WorkspaceFileError(400, 'file escapes workspace');
  const stat = statSync(file);
  if (stat.isDirectory()) throw new WorkspaceFileError(415, 'path is a directory');
  if (stat.size > MAX_TEXT_BYTES) throw new WorkspaceFileError(413, 'file is too large');
  const bytes = readFileSync(file);
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new WorkspaceFileError(413, 'file is too large');
  if (bytes.includes(0)) throw new WorkspaceFileError(415, 'file is binary');
  try {
    return {
      path: toWorkspacePath(path.relative(canonicalRoot, file)),
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    throw new WorkspaceFileError(415, 'file is not UTF-8 text');
  }
}
