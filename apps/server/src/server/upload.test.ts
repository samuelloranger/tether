import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveUploadPath } from './upload';

test('resolveUploadPath joins cwd + filename', () => {
  expect(resolveUploadPath('/home/sam/project', 'photo.jpg')).toBe('/home/sam/project/photo.jpg');
});

test('resolveUploadPath rejects a filename that escapes cwd', () => {
  expect(() => resolveUploadPath('/home/sam/project', '../../etc/passwd')).toThrow();
  expect(() => resolveUploadPath('/home/sam/project', 'sub/dir.txt')).toThrow();
});

test('resolveUploadPath collision-suffixes an existing file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-upload-test-'));
  try {
    const first = resolveUploadPath(dir, 'shot.png');
    writeFileSync(first, 'x');
    const second = resolveUploadPath(dir, 'shot.png');
    expect(second).not.toBe(first);
    expect(second).toBe(path.join(dir, 'shot-1.png'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
