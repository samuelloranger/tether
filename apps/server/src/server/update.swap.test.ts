import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { swapBinary } from './update';

function fixture(): { dir: string; target: string; tmp: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-swap-'));
  const target = path.join(dir, 'tether');
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

test('swapBinary parks nothing beside the target', () => {
  const { dir, target, tmp } = fixture();
  try {
    swapBinary(tmp, target);
    // The rename keeps the old inode alive for the running process with no help
    // from us, so nothing is left behind to sweep on the next update.
    expect(readdirSync(dir)).toEqual([path.basename(target)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed swap leaves the original binary in place rather than none', () => {
  const { dir, target } = fixture();
  const missing = path.join(dir, 'does-not-exist');
  try {
    expect(() => swapBinary(missing, target)).toThrow();
    // The property worth pinning: a botched update must never leave the host
    // with no `tether` at all.
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('OLD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
