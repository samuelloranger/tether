import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readWorkspaceFile, WorkspaceFileError } from './workspaceFile';

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
      symlinkSync(outsideFile, path.join(root, 'escape.txt'));

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

      expect(() => readWorkspaceFile(root, 'escape.txt')).toThrow(WorkspaceFileError);
      try {
        readWorkspaceFile(root, 'escape.txt');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceFileError);
        expect((error as WorkspaceFileError).status).toBe(400);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
