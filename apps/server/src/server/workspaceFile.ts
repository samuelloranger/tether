import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_TEXT_BYTES = 1_048_576;
const inside = (root: string, value: string) =>
  value === root || value.startsWith(`${root}${path.sep}`);

export class WorkspaceFileError extends Error {
  constructor(
    readonly status: 400 | 404 | 413 | 415,
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
  const canonicalRoot = realpathSync(root);
  let base = canonicalRoot;
  if (cwd) {
    try {
      base = realpathSync(cwd);
    } catch {
      throw new WorkspaceFileError(400, 'invalid working directory');
    }
    if (!inside(canonicalRoot, base))
      throw new WorkspaceFileError(400, 'working directory escapes workspace');
  }
  let file: string;
  try {
    file = realpathSync(path.resolve(base, requestedPath));
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
      path: path.relative(canonicalRoot, file),
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    throw new WorkspaceFileError(415, 'file is not UTF-8 text');
  }
}
