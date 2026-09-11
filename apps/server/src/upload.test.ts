import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveUploadPath } from './upload';

// A native absolute path, so the expectation matches the separator path.join
// actually produces — hardcoding "/home/sam/project/photo.jpg" only described
// POSIX, where the same call yields "\home\sam\project\photo.jpg" on Windows.
const WORKSPACE = path.resolve('/home/sam/project');

test('resolveUploadPath joins cwd + filename', () => {
  expect(resolveUploadPath(WORKSPACE, 'photo.jpg')).toBe(path.join(WORKSPACE, 'photo.jpg'));
});

test('resolveUploadPath rejects a filename that escapes cwd', () => {
  expect(() => resolveUploadPath(WORKSPACE, '../../etc/passwd')).toThrow();
  expect(() => resolveUploadPath(WORKSPACE, 'sub/dir.txt')).toThrow();
  // Backslash is a separator on Windows, so it must be rejected too — the guard
  // already checks both, and this pins that it keeps doing so.
  expect(() => resolveUploadPath(WORKSPACE, 'sub\\dir.txt')).toThrow();
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

// POSIX accepts names Win32 could not: ":" is an ordinary character, a file
// called CON is unremarkable, and a trailing dot or space is part of the name.
test('accepts names that only a Win32 filesystem would reject', () => {
  expect(resolveUploadPath(WORKSPACE, 'notes.txt:hidden')).toBe(
    path.join(WORKSPACE, 'notes.txt:hidden'),
  );
  for (const name of ['CON', 'NUL', 'COM1', 'CON.txt']) {
    expect(resolveUploadPath(WORKSPACE, name)).toBe(path.join(WORKSPACE, name));
  }
  expect(resolveUploadPath(WORKSPACE, 'evil.txt.')).toBe(path.join(WORKSPACE, 'evil.txt.'));
});

test('a name that merely starts with a device name is still allowed', () => {
  expect(resolveUploadPath(WORKSPACE, 'CONTACTS.txt')).toBe(path.join(WORKSPACE, 'CONTACTS.txt'));
  expect(resolveUploadPath(WORKSPACE, 'console.log')).toBe(path.join(WORKSPACE, 'console.log'));
});

test('rejects an empty filename and a NUL byte on every platform', () => {
  // An empty name makes path.join return the directory itself, which always
  // exists — the collision loop then walks off the end and writes siblings
  // named "<dir>-1". A NUL byte is illegal on every filesystem here.
  expect(() => resolveUploadPath(WORKSPACE, '')).toThrow(/invalid filename/);
  expect(() => resolveUploadPath(WORKSPACE, 'a\u0000b.txt')).toThrow(/NUL byte/);
});

test('ordinary filenames are untouched by the new checks', () => {
  for (const name of ['photo.jpg', 'my report (final).pdf', '.gitignore', 'a-b_c.2024.tar.gz']) {
    expect(resolveUploadPath(WORKSPACE, name)).toBe(path.join(WORKSPACE, name));
  }
});
