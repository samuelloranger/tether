import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { toWorkspacePath } from './workspacePath';

const MAX_TEXT_BYTES = 1_048_576;

/**
 * Resolve a path to the one spelling every containment check in this module
 * compares against: symlinks followed, so the workspace root and the requested
 * file are comparable even though they arrive from different places — the root
 * from git, the cwd from the shell's OSC 7, the path from the client.
 */
export function canonicalPath(target: string): string {
  return realpathSync(target);
}

/** Are two canonical paths the same path? */
export function samePath(a: string, b: string): boolean {
  return a === b;
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
  return value === root || value.startsWith(`${root}${path.sep}`);
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
