import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceFileError } from './workspaceFile';

const MAX_ENTRIES = 2000;
// Names held while sorting. Far above MAX_ENTRIES so ordinary large directories
// sort correctly, low enough that a pathological one cannot exhaust memory.
const SCAN_CEILING = 50_000;
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
  // lstat, not stat: the target came from realpathSync so it is already
  // symlink-free, and lstat lets the identity below be compared against what we
  // validated rather than against whatever the name resolves to later.
  const validated = lstatSync(target);
  if (!validated.isDirectory()) throw new WorkspaceFileError(415, 'path is not a directory');

  // Names first, cheaply, then sort, THEN stat only the page we return.
  //
  // The previous version took the filesystem's arbitrary first 2000 entries and
  // sorted afterwards, so in a directory of 2001+ files some entries were
  // permanently unreachable — sorted output that silently omitted whatever the
  // readdir order happened to put last. It also stat'd every entry it walked.
  const names: { name: string; isDir: boolean; isLink: boolean }[] = [];
  let scanned = 0;
  const handle = opendirSync(target);
  try {
    while (true) {
      const dirent = handle.readSync();
      if (dirent === null) break;
      scanned += 1;
      // A ceiling on the NAMES held in memory, well above MAX_ENTRIES, so a
      // pathological directory cannot make this allocate without bound while
      // ordinary large ones still sort correctly before being paged.
      if (names.length >= SCAN_CEILING) break;
      names.push({
        name: dirent.name,
        isDir: dirent.isDirectory(),
        isLink: dirent.isSymbolicLink(),
      });
    }
  } finally {
    handle.closeSync();
  }

  // Was the directory we just read still the one we validated?
  //
  // Containment is checked by resolving the path, but the path is resolved again
  // when it is opened, so between those two steps the name can be swapped for a
  // symlink pointing outside the workspace. Comparing the device and inode of
  // what we validated against what we hold now closes that: on a swap the
  // identity differs and the listing is discarded rather than returned.
  //
  // This is verify-after-read, not openat(2) — Node cannot readdir from a file
  // descriptor, so a genuinely atomic version is not expressible here. What it
  // guarantees is that no result which escaped the workspace is ever RETURNED.
  const after = lstatSync(target);
  if (after.dev !== validated.dev || after.ino !== validated.ino) {
    throw new WorkspaceFileError(409, 'directory changed while it was being read');
  }
  if (realpathSync(target) !== target) {
    throw new WorkspaceFileError(409, 'directory changed while it was being read');
  }

  names.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const truncated = scanned > MAX_ENTRIES || names.length >= SCAN_CEILING;
  const page = names.slice(0, MAX_ENTRIES);

  const entries: WorkspaceDirEntry[] = [];
  for (const item of page) {
    const full = path.join(target, item.name);
    let size = 0;
    try {
      size = lstatSync(full).size;
    } catch {
      // Vanished between the read and the stat. Report it rather than failing
      // the whole listing over one entry.
      size = 0;
    }
    if (item.isLink) {
      let resolved: string | null = null;
      try {
        resolved = realpathSync(full);
      } catch {
        resolved = null;
      }
      // A link out of the workspace is listed as an ordinary empty file: its
      // name is not a secret, its target is.
      entries.push({
        name: item.name,
        kind: 'file',
        size: !resolved || !inside(canonicalRoot, resolved) ? 0 : size,
      });
      continue;
    }
    entries.push({ name: item.name, kind: item.isDir ? 'dir' : 'file', size });
  }


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
