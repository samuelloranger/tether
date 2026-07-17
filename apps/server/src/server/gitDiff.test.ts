import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitDiffError, readDiff, readDiffSummary } from './gitDiff';

function withRepo(fn: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-gitdiff-'));
  try {
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
    execSync('git add main.ts && git commit -q -m initial', { cwd: root });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('summarizes an unstaged change against HEAD', () => {
  withRepo((root) => {
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    const summary = readDiffSummary(root);
    expect(summary.files).toEqual([{ path: 'main.ts', insertions: 1, deletions: 1 }]);
  });
});

test('returns the unified diff for a single file', () => {
  withRepo((root) => {
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    const { diff, truncated } = readDiff(root, 'main.ts');
    expect(truncated).toBe(false);
    expect(diff).toContain('-export const answer = 42;');
    expect(diff).toContain('+export const answer = 43;');
  });
});

test('rejects a traversal path', () => {
  withRepo((root) => {
    expect(() => readDiff(root, '../secret.txt')).toThrow(GitDiffError);
  });
});

test('truncates a diff larger than 1 MiB and reports truncated: true', () => {
  withRepo((root) => {
    writeFileSync(path.join(root, 'main.ts'), 'x'.repeat(1_048_577));
    const { diff, truncated } = readDiff(root);
    expect(truncated).toBe(true);
    expect(diff.length).toBe(1_048_576);
  });
});

test('reports an error for a non-repo root', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tether-notgit-'));
  try {
    expect(() => readDiffSummary(dir)).toThrow(GitDiffError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
