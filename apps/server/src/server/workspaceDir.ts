import { lstatSync, opendirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceFileError } from './workspaceFile';

const MAX_ENTRIES = 2000;
const inside = (root: string, value: string) =>
  value === root || value.startsWith(`${root}${path.sep}`);

export type WorkspaceDirEntry = {
  name: string;
  kind: 'file' | 'dir';
  size: number;
};

export function readWorkspaceDir(root: string, requestedPath: string, cwd?: string) {
  if (path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes('..'))
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
  let target: string;
  try {
    target = realpathSync(requestedPath ? path.resolve(base, requestedPath) : base);
  } catch {
    throw new WorkspaceFileError(404, 'file not found');
  }
  if (!inside(canonicalRoot, target)) throw new WorkspaceFileError(400, 'path escapes workspace');
  const stat = statSync(target);
  if (!stat.isDirectory()) throw new WorkspaceFileError(415, 'path is not a directory');

  const entries: WorkspaceDirEntry[] = [];
  let truncated = false;
  const handle = opendirSync(target);
  try {
    while (true) {
      const dirent = handle.readSync();
      if (dirent === null) break;
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const full = path.join(target, dirent.name);
      if (dirent.isSymbolicLink()) {
        let resolved: string | null = null;
        try {
          resolved = realpathSync(full);
        } catch {
          resolved = null;
        }
        if (!resolved || !inside(canonicalRoot, resolved)) {
          entries.push({ name: dirent.name, kind: 'file', size: 0 });
        } else {
          entries.push({ name: dirent.name, kind: 'file', size: lstatSync(full).size });
        }
        continue;
      }
      const lst = lstatSync(full);
      entries.push({
        name: dirent.name,
        kind: dirent.isDirectory() ? 'dir' : 'file',
        size: lst.size,
      });
    }
  } finally {
    handle.closeSync();
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const result: {
    path: string;
    entries: WorkspaceDirEntry[];
    truncated?: true;
  } = {
    path: path.relative(canonicalRoot, target),
    entries,
  };
  if (truncated) result.truncated = true;
  return result;
}
