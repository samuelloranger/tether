import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanupDisplacedBinaries, swapBinary } from './update';

const IS_WINDOWS = process.platform === 'win32';

function fixture(): { dir: string; target: string; tmp: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-swap-'));
  const target = path.join(dir, IS_WINDOWS ? 'tether.exe' : 'tether');
  const tmp = path.join(dir, '.tether.new');
  writeFileSync(target, 'OLD');
  writeFileSync(tmp, 'NEW');
  return { dir, target, tmp };
}

test('swapBinary puts the downloaded binary at the target path', () => {
  const { dir, target, tmp } = fixture();
  try {
    swapBinary(tmp, target);
    expect(readFileSync(target, 'utf8')).toBe('NEW');
    expect(existsSync(tmp)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the replaced binary is parked on Windows and simply unlinked elsewhere', () => {
  const { dir, target, tmp } = fixture();
  try {
    swapBinary(tmp, target);
    const parked = readdirSync(dir).filter((f) => f.includes('.old'));
    if (IS_WINDOWS) {
      // Windows refuses to unlink a mapped executable, so the old image has to
      // survive under another name until whatever is running it exits.
      expect(parked).toEqual([`${path.basename(target)}.old`]);
      expect(readFileSync(path.join(dir, parked[0]), 'utf8')).toBe('OLD');
    } else {
      // POSIX keeps the old inode alive for the running process with no help
      // from us, so a single rename leaves nothing behind.
      expect(parked).toEqual([]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed swap restores the original binary rather than leaving none', () => {
  const { dir, target } = fixture();
  const missing = path.join(dir, 'does-not-exist');
  try {
    // The second rename is the one that can fail on Windows; a missing source
    // reproduces that without needing to hold a real lock.
    expect(() => swapBinary(missing, target)).toThrow();
    // The whole point of the rollback: `tether` must still be on disk, intact.
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('OLD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupDisplacedBinaries removes parked images and nothing else', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-sweep-'));
  const target = path.join(dir, 'tether.exe');
  try {
    writeFileSync(target, 'CURRENT');
    writeFileSync(`${target}.old`, 'PREVIOUS');
    // The timestamped variant only appears when a `.old` was still locked.
    writeFileSync(`${target}.old-1700000000000`, 'OLDER');
    writeFileSync(path.join(dir, 'tether.db'), 'DATA');

    cleanupDisplacedBinaries(target);

    expect(readdirSync(dir).sort()).toEqual(['tether.db', 'tether.exe']);
    expect(readFileSync(target, 'utf8')).toBe('CURRENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupDisplacedBinaries is silent when there is nothing to sweep', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-sweep-empty-'));
  try {
    expect(() => cleanupDisplacedBinaries(path.join(dir, 'tether.exe'))).not.toThrow();
    // A directory that does not exist at all must not throw either — the sweep
    // runs before anything has verified the install layout.
    expect(() => cleanupDisplacedBinaries(path.join(dir, 'nope', 'tether.exe'))).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
