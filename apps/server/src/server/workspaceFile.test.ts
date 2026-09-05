import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAN_SYMLINK } from '../../test-paths';
import {
  canonicalPath,
  inside,
  readWorkspaceFile,
  samePath,
  WorkspaceFileError,
} from './workspaceFile';

function withRoot(fn: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-workspace-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reads a nested file relative to cwd and returns workspace-relative path', () => {
  withRoot((root) => {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'main.ts'), 'export const answer = 42;\n');
    expect(readWorkspaceFile(root, 'main.ts', path.join(root, 'src'))).toEqual({
      path: 'src/main.ts',
      content: 'export const answer = 42;\n',
    });
  });
});

test('rejects traversal, absolute paths, directories, binary, oversized, and escaping symlinks', () => {
  withRoot((root) => {
    mkdirSync(path.join(root, 'dir'));
    writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]));
    writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(1_048_577, 0x61));

    const outside = mkdtempSync(path.join(tmpdir(), 'tether-outside-'));
    try {
      const outsideFile = path.join(outside, 'secret.txt');
      writeFileSync(outsideFile, 'nope\n');
      // Only the escaping-symlink half of this test needs a symlink; traversal,
      // absolute paths, directories, binary and oversized all behave the same
      // on Windows, so they keep running there rather than skipping the lot.
      if (CAN_SYMLINK) symlinkSync(outsideFile, path.join(root, 'escape.txt'));

      expect(() => readWorkspaceFile(root, '../secret.txt')).toThrow(WorkspaceFileError);
      try {
        readWorkspaceFile(root, '../secret.txt');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceFileError);
        expect((error as WorkspaceFileError).status).toBe(400);
      }

      expect(() => readWorkspaceFile(root, path.join(root, 'main.ts'))).toThrow(WorkspaceFileError);
      try {
        readWorkspaceFile(root, path.join(root, 'main.ts'));
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceFileError);
        expect((error as WorkspaceFileError).status).toBe(400);
      }

      expect(() => readWorkspaceFile(root, 'dir')).toThrow(WorkspaceFileError);
      try {
        readWorkspaceFile(root, 'dir');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceFileError);
        expect((error as WorkspaceFileError).status).toBe(415);
      }

      expect(() => readWorkspaceFile(root, 'binary.bin')).toThrow(WorkspaceFileError);
      try {
        readWorkspaceFile(root, 'binary.bin');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceFileError);
        expect((error as WorkspaceFileError).status).toBe(415);
      }

      expect(() => readWorkspaceFile(root, 'large.txt')).toThrow(WorkspaceFileError);
      try {
        readWorkspaceFile(root, 'large.txt');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceFileError);
        expect((error as WorkspaceFileError).status).toBe(413);
      }

      if (CAN_SYMLINK) {
        expect(() => readWorkspaceFile(root, 'escape.txt')).toThrow(WorkspaceFileError);
        try {
          readWorkspaceFile(root, 'escape.txt');
        } catch (error) {
          expect(error).toBeInstanceOf(WorkspaceFileError);
          expect((error as WorkspaceFileError).status).toBe(400);
        }
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// Path containment.
//
// The comparison these tests pin used to be a plain `===`/`startsWith` pair
// against `realpathSync` output. On Windows that is a case-sensitive comparison
// of a case-insensitive filesystem, and `realpathSync` there normalises neither
// letter case nor 8.3 short names (only `realpathSync.native` does), so one
// directory reached by two spellings compared unequal and a legitimate read was
// refused.

const IS_WINDOWS = process.platform === 'win32';

test('inside() rejects a sibling that merely shares a prefix', () => {
  // The separator in the comparison is what stops /srv/workspace-evil from
  // reading as a child of /srv/workspace. True on every platform.
  const root = path.resolve('/srv/workspace');
  expect(inside(root, root)).toBe(true);
  expect(inside(root, path.join(root, 'a', 'b.txt'))).toBe(true);
  expect(inside(root, `${root}-evil`)).toBe(false);
  expect(inside(root, path.resolve('/srv'))).toBe(false);
  expect(inside(root, path.resolve('/etc/passwd'))).toBe(false);
});

test('inside() folds case on Windows only, and never loosens POSIX', () => {
  const root = path.resolve('/srv/Workspace');
  const child = path.join(root.toUpperCase(), 'file.txt');
  if (IS_WINDOWS) {
    // One directory, two spellings — the filesystem says they are the same, so
    // the containment check has to agree or it denies a legitimate read.
    expect(inside(root, child)).toBe(true);
    expect(samePath(root, root.toLowerCase())).toBe(true);
  } else {
    // /srv/Workspace and /SRV/WORKSPACE are genuinely different directories
    // here. Folding case would let one be mistaken for the other, which is a
    // real weakening rather than a portability fix.
    expect(inside(root, child)).toBe(false);
    expect(samePath(root, root.toLowerCase())).toBe(false);
  }
  // Case folding must not turn a denial into an escape on either platform.
  expect(inside(root, path.resolve('/etc/passwd'))).toBe(false);
  expect(inside(root, `${root.toUpperCase()}-EVIL`)).toBe(false);
});

test('canonicalPath resolves every spelling of one directory to the same string', () => {
  withRoot((root) => {
    mkdirSync(path.join(root, 'src'));
    const canonical = canonicalPath(path.join(root, 'src'));
    // Idempotent, and agrees with itself however it was reached.
    expect(canonicalPath(canonical)).toBe(canonical);
    if (IS_WINDOWS) {
      // mkdtempSync builds on os.tmpdir(), which hands back an 8.3 SHORT path
      // (C:\Users\SAMUEL~1.LOR\...). Upper-casing on top of that gives a third
      // spelling. All of them must land on one canonical form, or containment
      // compares a long root against a short child and refuses the read.
      expect(canonicalPath(path.join(root, 'src').toUpperCase())).toBe(canonical);
      expect(canonicalPath(path.join(root.toLowerCase(), 'src'))).toBe(canonical);
      expect(canonical).not.toContain('~');
    }
  });
});

test('a root and a cwd spelled differently still describe one workspace', () => {
  withRoot((root) => {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'main.ts'), 'export const answer = 42;\n');
    // The realistic shape of the Windows bug: the root arrives from git (long
    // form) while the cwd arrives from the shell's OSC 7, or the reverse, and
    // the two spellings never matched. Exercised with the most divergent pair
    // this host can produce.
    const longRoot = canonicalPath(root);
    const shortishCwd = IS_WINDOWS ? path.join(root.toUpperCase(), 'SRC') : path.join(root, 'src');
    expect(readWorkspaceFile(longRoot, 'main.ts', shortishCwd)).toEqual({
      path: 'src/main.ts',
      content: 'export const answer = 42;\n',
    });
    // ...and the reverse pairing.
    expect(readWorkspaceFile(root, 'main.ts', path.join(longRoot, 'src'))).toEqual({
      path: 'src/main.ts',
      content: 'export const answer = 42;\n',
    });
  });
});

test('a cwd outside the root is still rejected however either is spelled', () => {
  withRoot((root) => {
    const outside = mkdtempSync(path.join(tmpdir(), 'tether-outside-cwd-'));
    try {
      writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
      const spellings = IS_WINDOWS
        ? [outside, outside.toUpperCase(), canonicalPath(outside)]
        : [outside];
      for (const cwd of spellings) {
        try {
          readWorkspaceFile(root, 'secret.txt', cwd);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(WorkspaceFileError);
          expect((error as WorkspaceFileError).status).toBe(400);
          expect((error as WorkspaceFileError).message).toBe('working directory escapes workspace');
        }
      }
      // The sibling-prefix escape, which case folding must not open up either.
      const sibling = `${root}-evil`;
      mkdirSync(sibling);
      try {
        expect(() => readWorkspaceFile(root, 'x.txt', sibling)).toThrow(WorkspaceFileError);
      } finally {
        rmSync(sibling, { recursive: true, force: true });
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
