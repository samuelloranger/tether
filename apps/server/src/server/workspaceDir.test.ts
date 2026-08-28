import { expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAN_SYMLINK } from '../../test-paths';
import { readWorkspaceDir } from './workspaceDir';
import { canonicalPath, WorkspaceFileError } from './workspaceFile';

function withRoot(fn: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-workspace-dir-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('lists entries with directories before files, alphabetically', () => {
  withRoot((root) => {
    mkdirSync(path.join(root, 'zebra'));
    mkdirSync(path.join(root, 'alpha'));
    writeFileSync(path.join(root, 'readme.txt'), 'hi\n');
    writeFileSync(path.join(root, 'a.txt'), 'a\n');
    writeFileSync(path.join(root, '.dotfile'), 'hidden\n');

    const result = readWorkspaceDir(root, '');
    expect(result.path).toBe('');
    expect(result.entries.map((e) => e.name)).toEqual([
      'alpha',
      'zebra',
      '.dotfile',
      'a.txt',
      'readme.txt',
    ]);
    expect(result.entries.map((e) => e.kind)).toEqual(['dir', 'dir', 'file', 'file', 'file']);
    expect(result).not.toHaveProperty('truncated');
  });
});

test('empty requestedPath lists the cwd', () => {
  withRoot((root) => {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'main.ts'), 'export {};\n');
    writeFileSync(path.join(root, 'root.txt'), 'root\n');

    const result = readWorkspaceDir(root, '', path.join(root, 'src'));
    expect(result.path).toBe('src');
    expect(result.entries).toEqual([
      { name: 'main.ts', kind: 'file', size: 'export {};\n'.length },
    ]);
  });
});

test('rejects ".." path with 400', () => {
  withRoot((root) => {
    try {
      readWorkspaceDir(root, '../secret');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceFileError);
      expect((error as WorkspaceFileError).status).toBe(400);
      expect((error as WorkspaceFileError).message).toBe('invalid file path');
    }
  });
});

test('rejects absolute path with 400', () => {
  withRoot((root) => {
    try {
      readWorkspaceDir(root, path.join(root, 'anything'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceFileError);
      expect((error as WorkspaceFileError).status).toBe(400);
      expect((error as WorkspaceFileError).message).toBe('invalid file path');
    }
  });
});

// Needs a symlink fixture, which a default Windows install refuses to create.
test.skipIf(!CAN_SYMLINK)(
  'symlink pointing outside the root is reported as file size 0, not escaping',
  () => {
    withRoot((root) => {
      const outside = mkdtempSync(path.join(tmpdir(), 'tether-outside-dir-'));
      try {
        writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
        symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
        writeFileSync(path.join(root, 'safe.txt'), 'ok\n');

        const result = readWorkspaceDir(root, '');
        const escapeEntry = result.entries.find((e) => e.name === 'escape.txt');
        expect(escapeEntry).toEqual({ name: 'escape.txt', kind: 'file', size: 0 });
        expect(result.entries.some((e) => e.name === 'safe.txt')).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  },
);

test('rejects a file path with 415', () => {
  withRoot((root) => {
    writeFileSync(path.join(root, 'file.txt'), 'x\n');
    try {
      readWorkspaceDir(root, 'file.txt');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceFileError);
      expect((error as WorkspaceFileError).status).toBe(415);
      expect((error as WorkspaceFileError).message).toBe('path is not a directory');
    }
  });
});

// Creating 2005 files is IO-bound and wildly platform-dependent: ~1s on ext4,
// ~11.4s on NTFS, where each create is a separate synchronous kernel round trip
// through the filter-driver stack (Defender included). That blows bun:test's
// 5s default and fails a test that is not actually slow at what it measures, so
// the budget is scaled to the filesystem rather than the assertion.
const BIG_DIR_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 15_000;

test(
  'caps listing at 2000 entries and sets truncated',
  () => {
    withRoot((root) => {
      for (let i = 0; i < 2005; i++) {
        writeFileSync(path.join(root, `f${String(i).padStart(4, '0')}.txt`), 'x');
      }
      const result = readWorkspaceDir(root, '');
      expect(result.entries).toHaveLength(2000);
      expect(result.truncated).toBe(true);

      // The page must be the sorted PREFIX, not an arbitrary 2000 sorted after
      // the fact. Slicing before sorting made whichever names readdir happened to
      // return last permanently unreachable — invisible, because the output still
      // came back neatly ordered.
      expect(result.entries[0]?.name).toBe('f0000.txt');
      expect(result.entries[1999]?.name).toBe('f1999.txt');
      expect(result.entries.map((e) => e.name)).not.toContain('f2004.txt');
    });
  },
  BIG_DIR_TIMEOUT_MS,
);

// ---------------------------------------------------------------------------
// Containment, mirroring workspaceFile.test.ts. The listing route resolves paths
// with the same helpers, so the same Windows spelling hazards apply to it.
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32';

test('lists a directory however the root and cwd are spelled', () => {
  withRoot((root) => {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'main.ts'), 'export {};\n');
    const longRoot = canonicalPath(root);
    const cwd = IS_WINDOWS ? path.join(root.toUpperCase(), 'SRC') : path.join(root, 'src');
    const result = readWorkspaceDir(longRoot, '', cwd);
    // Reported back workspace-relative, so a divergent spelling must not leak
    // into the path the client sees either.
    expect(result.path).toBe('src');
    expect(result.entries.map((e) => e.name)).toEqual(['main.ts']);
  });
});

test('a cwd outside the root is rejected however it is spelled', () => {
  withRoot((root) => {
    const outside = mkdtempSync(path.join(tmpdir(), 'tether-outside-dir-cwd-'));
    try {
      writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
      const spellings = IS_WINDOWS
        ? [outside, outside.toUpperCase(), canonicalPath(outside)]
        : [outside];
      for (const cwd of spellings) {
        try {
          readWorkspaceDir(root, '', cwd);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(WorkspaceFileError);
          expect((error as WorkspaceFileError).status).toBe(400);
          expect((error as WorkspaceFileError).message).toBe('working directory escapes workspace');
        }
      }
      // A sibling sharing the root's prefix must not read as being inside it —
      // the case folding added for Windows must not open this up.
      const sibling = `${root}-evil`;
      mkdirSync(sibling);
      try {
        expect(() => readWorkspaceDir(root, '', sibling)).toThrow(WorkspaceFileError);
      } finally {
        rmSync(sibling, { recursive: true, force: true });
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The dev/ino identity check that closes the read-then-swap window.
//
// Measured on Windows 11 / NTFS before this was trusted: libuv DOES populate ino
// from the 64-bit NTFS file id. It is non-zero, stable across repeated stats and
// across case and short-name spellings of the same path, and it changes when the
// directory is replaced — so the check is real here, not a no-op that passes
// everything.
//
// What it is NOT is safe to read as a JS number. A sampled id was
// 34621422136632508 against a Number.MAX_SAFE_INTEGER of 9007199254740991;
// above that ceiling doubles round to multiples of 8, and an NTFS file id packs
// a sequence number over an MFT record index, so directories in adjacent records
// differ by one and collapse onto the same number. 500 sibling directories gave
// 500 distinct BigInt ids but only 497 distinct number ids. Hence
// `lstatSync(..., {bigint: true})` in workspaceDir.ts.
// ---------------------------------------------------------------------------

test('lstat ino is populated and distinguishes directories on this host', () => {
  withRoot((root) => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    mkdirSync(a);
    mkdirSync(b);

    const idA = lstatSync(a, { bigint: true });
    const idB = lstatSync(b, { bigint: true });

    // A zero or constant ino would make the TOCTOU check in readWorkspaceDir
    // pass for everything, silently. Assert it does not.
    expect(idA.ino).not.toBe(0n);
    expect(idB.ino).not.toBe(0n);
    expect(idA.ino).not.toBe(idB.ino);

    // Stable: re-stating the same directory yields the same identity, so the
    // check cannot produce spurious 409s on an untouched directory.
    expect(lstatSync(a, { bigint: true }).ino).toBe(idA.ino);

    // ...and stable across spellings, which is what lets it be compared against
    // a canonicalPath-resolved target.
    if (IS_WINDOWS) {
      expect(lstatSync(a.toUpperCase(), { bigint: true }).ino).toBe(idA.ino);
      expect(lstatSync(canonicalPath(a), { bigint: true }).ino).toBe(idA.ino);
    }

    // A replaced directory reads as a different object — on Windows.
    //
    // Deliberately not asserted on POSIX: inode numbers are RECYCLED there, and
    // the allocator commonly hands the just-freed one straight back, so a
    // recreated directory often has the identity of the one it replaced. That
    // is not a flake to paper over; it is why readWorkspaceDir does not rest on
    // dev+ino alone and re-checks `realpathSync(target) === target` afterwards.
    // The delete-and-recreate case is caught by that second guard, not this one.
    //
    // (Observed: ext4 on the CI runner recycled it; the WSL2 volume here did
    // not. Either is legal, which is exactly why nothing may depend on it.)
    if (IS_WINDOWS) {
      rmSync(b, { recursive: true, force: true });
      mkdirSync(b);
      expect(lstatSync(b, { bigint: true }).ino).not.toBe(idB.ino);
    }
  });
});

test('a normal listing does not trip the identity check', () => {
  // The other half of the above: the check must be exact enough to catch a swap
  // and quiet enough never to reject an ordinary read.
  withRoot((root) => {
    for (let i = 0; i < 20; i++) writeFileSync(path.join(root, `f${i}.txt`), 'x');
    for (let i = 0; i < 5; i++) {
      expect(readWorkspaceDir(root, '').entries).toHaveLength(20);
    }
  });
});
