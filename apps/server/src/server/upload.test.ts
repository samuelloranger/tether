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

// The Windows-specific hazards. Gated on the host, because resolveUploadPath is
// gated on the host: `a:b` and `CON` are legal, ordinary filenames on Linux
// and macOS, so the same call must SUCCEED there. Both directions are asserted
// below rather than skipping one platform, so neither branch can rot.
const IS_WINDOWS = process.platform === 'win32';

test('rejects an alternate-data-stream filename on Windows, accepts it on POSIX', () => {
  // "notes.txt:hidden" writes into an NTFS stream hanging off notes.txt that no
  // directory listing shows, and that the collision loop cannot see either. On
  // POSIX ':' is just a character in a name.
  if (IS_WINDOWS) {
    expect(() => resolveUploadPath(WORKSPACE, 'notes.txt:hidden')).toThrow(/invalid filename/);
    expect(() => resolveUploadPath(WORKSPACE, 'a:b')).toThrow(/invalid filename/);
  } else {
    expect(resolveUploadPath(WORKSPACE, 'notes.txt:hidden')).toBe(
      path.join(WORKSPACE, 'notes.txt:hidden'),
    );
  }
});

test('rejects reserved Windows device names, including with an extension', () => {
  const reserved = ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'CON.txt', 'nul.log'];
  for (const name of reserved) {
    if (IS_WINDOWS) {
      expect(() => resolveUploadPath(WORKSPACE, name)).toThrow(/reserved Windows device name/);
    } else {
      // A file called CON is unremarkable on Linux; rejecting it there would be
      // a functional regression bought for no security at all.
      expect(resolveUploadPath(WORKSPACE, name)).toBe(path.join(WORKSPACE, name));
    }
  }
});

test('a name that merely starts with a device name is still allowed', () => {
  // The reservation covers the stem before the first dot, not any prefix —
  // "CONTACTS.txt" and "console.log" are ordinary files on Windows too.
  expect(resolveUploadPath(WORKSPACE, 'CONTACTS.txt')).toBe(path.join(WORKSPACE, 'CONTACTS.txt'));
  expect(resolveUploadPath(WORKSPACE, 'console.log')).toBe(path.join(WORKSPACE, 'console.log'));
  expect(resolveUploadPath(WORKSPACE, 'COM10.txt')).toBe(path.join(WORKSPACE, 'COM10.txt'));
});

test('rejects trailing dots and spaces on Windows, where they are silently stripped', () => {
  // Win32 strips them on the way to the filesystem, so "evil.txt." opens
  // "evil.txt" — two spellings racing for one file, which defeats the
  // collision-suffix logic entirely.
  if (IS_WINDOWS) {
    expect(() => resolveUploadPath(WORKSPACE, 'evil.txt.')).toThrow(/silently strips/);
    expect(() => resolveUploadPath(WORKSPACE, 'evil.txt ')).toThrow(/silently strips/);
  } else {
    expect(resolveUploadPath(WORKSPACE, 'evil.txt.')).toBe(path.join(WORKSPACE, 'evil.txt.'));
  }
});

test('rejects characters NTFS cannot store, on Windows', () => {
  if (!IS_WINDOWS) return;
  for (const name of ['a<b.txt', 'a>b.txt', 'a"b.txt', 'a|b.txt', 'a?b.txt', 'a*b.txt']) {
    expect(() => resolveUploadPath(WORKSPACE, name)).toThrow(/Windows cannot store/);
  }
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
