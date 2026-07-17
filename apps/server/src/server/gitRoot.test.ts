import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findGitRoot, resolveGitDir, resolveGitRoot } from './gitRoot';

test('resolves the git top-level for a nested cwd inside a repo', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-gitroot-'));
  try {
    execSync('git init -q', { cwd: root });
    mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    expect(resolveGitRoot(path.join(root, 'src', 'nested'))).toBe(realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('falls back to the cwd itself when it is not inside a git repo', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-notgit-'));
  try {
    expect(resolveGitRoot(dir)).toBe(realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strictly finds a git root and absolute git directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-gitroot-'));
  try {
    execSync('git init -q', { cwd: root });
    expect(findGitRoot(root)).toBe(realpathSync(root));
    expect(resolveGitDir(root)).toBe(path.join(realpathSync(root), '.git'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('returns null when strictly finding a git root outside a repository', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-notgit-'));
  try {
    expect(findGitRoot(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
