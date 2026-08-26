import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readWorkspaceDir } from './workspaceDir';
import { WorkspaceFileError } from './workspaceFile';

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

test('symlink pointing outside the root is reported as file size 0, not escaping', () => {
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
});

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

test('caps listing at 2000 entries and sets truncated', () => {
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
});
