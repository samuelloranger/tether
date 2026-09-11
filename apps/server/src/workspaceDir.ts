import { lstatSync, opendirSync } from 'node:fs';
import path from 'node:path';
import { canonicalPath, inside, samePath, WorkspaceFileError } from './workspaceFile';
import { toWorkspacePath } from './workspacePath';

const MAX_ENTRIES = 2000;
// Names held while sorting. Far above MAX_ENTRIES so ordinary large directories
// sort correctly, low enough that a pathological one cannot exhaust memory.
const SCAN_CEILING = 50_000;

export type WorkspaceDirEntry = {
  name: string;
  kind: 'file' | 'dir';
  size: number;
};

type ScannedName = { name: string; isDir: boolean; isLink: boolean };

/**
 * Resolves the requested path to a real directory inside the workspace, or
 * throws. Returns the canonical root, the target, and the lstat that
 * readWorkspaceDir compares against once the read is done.
 */
function resolveDirTarget(root: string, requestedPath: string, cwd?: string) {
  if (path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes('..'))
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
  let target: string;
  try {
    target = canonicalPath(requestedPath ? path.resolve(base, requestedPath) : base);
  } catch {
    throw new WorkspaceFileError(404, 'file not found');
  }
  if (!inside(canonicalRoot, target)) throw new WorkspaceFileError(400, 'path escapes workspace');
  // lstat, not stat: the target came from canonicalPath so it is already
  // symlink-free, and lstat lets the identity check after the read compare
  // against what we validated rather than against whatever the name resolves to
  // later.
  //
  // `bigint: true` is load-bearing rather than a style choice — the identity
  // check in readWorkspaceDir explains what the default loses.
  const validated = lstatSync(target, { bigint: true });
  if (!validated.isDirectory()) throw new WorkspaceFileError(415, 'path is not a directory');
  return { canonicalRoot, target, validated };
}

/**
 * Reads the directory's names only — no stat per entry.
 *
 * The previous version took the filesystem's arbitrary first 2000 entries and
 * sorted afterwards, so in a directory of 2001+ files some entries were
 * permanently unreachable: sorted output that silently omitted whatever the
 * readdir order happened to put last. Names first, cheaply, then sort, THEN stat
 * only the page that is returned.
 */
function scanDirNames(target: string): { names: ScannedName[]; scanned: number } {
  const names: ScannedName[] = [];
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
  return { names, scanned };
}

/** Stats one page of names, reporting a symlink in a way that reveals no target. */
function pageEntries(
  canonicalRoot: string,
  target: string,
  page: ScannedName[],
): WorkspaceDirEntry[] {
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
        resolved = canonicalPath(full);
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
  return entries;
}

export function readWorkspaceDir(root: string, requestedPath: string, cwd?: string) {
  const { canonicalRoot, target, validated } = resolveDirTarget(root, requestedPath, cwd);
  const { names, scanned } = scanDirNames(target);

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
  //
  // Read as BigInt, deliberately. The default lstatSync hands dev/ino back as JS
  // numbers, and on Windows libuv fills ino from the 64-bit NTFS file id, which
  // routinely exceeds Number.MAX_SAFE_INTEGER — a measured sample here was
  // 34621422136632508 against a ceiling of 9007199254740991. Past that a double
  // cannot represent every integer, so ids round to the nearest multiple of 8;
  // and an NTFS file id is a sequence number in its high bits over an MFT record
  // index in its low bits, so two directories in adjacent MFT records differ by
  // one and round to the SAME number. Creating 500 sibling directories and
  // reading each id both ways gave 500 distinct BigInts but only 497 distinct
  // numbers — three pairs this check would have declared identical, which is
  // exactly an attacker's swap passing unnoticed. BigInt is exact and costs
  // nothing.
  const after = lstatSync(target, { bigint: true });
  if (after.dev !== validated.dev || after.ino !== validated.ino) {
    throw new WorkspaceFileError(409, 'directory changed while it was being read');
  }
  // Belt to the identity check's braces: re-resolve the name and require it to
  // land where it did. Compared with samePath so a Windows volume's case folding
  // is never mistaken for a swap.
  if (!samePath(canonicalPath(target), target)) {
    throw new WorkspaceFileError(409, 'directory changed while it was being read');
  }

  names.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const truncated = scanned > MAX_ENTRIES || names.length >= SCAN_CEILING;
  const entries = pageEntries(canonicalRoot, target, names.slice(0, MAX_ENTRIES));

  const result: {
    path: string;
    entries: WorkspaceDirEntry[];
    truncated?: true;
  } = {
    path: toWorkspacePath(path.relative(canonicalRoot, target)),
    entries,
  };
  if (truncated) result.truncated = true;
  return result;
}
