import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canRewriteHead, formatRepoStatusLabel, readRepoStatus } from './gitStatus';

function withRepo(fn: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-gitstatus-'));
  try {
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(path.join(root, 'a.txt'), 'one\n');
    execSync('git add a.txt && git commit -q -m initial', { cwd: root });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('readRepoStatus reports branch with no upstream', () => {
  withRepo((root) => {
    const status = readRepoStatus(root);
    expect(status.detached).toBe(false);
    expect(status.branch).toBeTruthy();
    expect(status.upstream).toBeNull();
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(canRewriteHead(status)).toBe(true);
    expect(formatRepoStatusLabel(status)).toBe(status.branch);
  });
});

test('canRewriteHead is false when upstream exists and ahead is 0', () => {
  expect(
    canRewriteHead({
      branch: 'main',
      shortSha: 'abc',
      detached: false,
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
    }),
  ).toBe(false);
  expect(
    canRewriteHead({
      branch: 'main',
      shortSha: 'abc',
      detached: false,
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
    }),
  ).toBe(true);
});

test('formatRepoStatusLabel shows ahead/behind and detached', () => {
  expect(
    formatRepoStatusLabel({
      branch: 'main',
      shortSha: 'abc',
      detached: false,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    }),
  ).toBe('main ↑2 ↓1');
  expect(
    formatRepoStatusLabel({
      branch: '',
      shortSha: 'deadbeef',
      detached: true,
      upstream: null,
      ahead: 0,
      behind: 0,
    }),
  ).toBe('detached @ deadbeef');
});
