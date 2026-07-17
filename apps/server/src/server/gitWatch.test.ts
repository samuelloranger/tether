import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiffSummary } from './gitDiff';
import { GitWatch } from './gitWatch';

async function withRepo(fn: (root: string) => void | Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-gitwatch-'));
  try {
    execSync('git init -q', { cwd: root });
    execSync('git config user.email test@example.com', { cwd: root });
    execSync('git config user.name test', { cwd: root });
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
    execSync('git add main.ts && git commit -q -m initial', { cwd: root });
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitFor(condition: () => boolean, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await Bun.sleep(20);
  expect(condition()).toBe(true);
}

test('debounces native worktree events and suppresses an identical summary', async () => {
  await withRepo(async (root) => {
    const seen: DiffSummary[] = [];
    const watch = new GitWatch((summary) => seen.push(summary), 150);
    watch.setRoot(root);
    expect(seen).toEqual([{ files: [] }]);

    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 44;\n');
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([
      { files: [] },
      { files: [{ path: 'main.ts', insertions: 1, deletions: 1 }] },
    ]);

    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    await Bun.sleep(250);
    expect(seen).toHaveLength(2);

    execSync('git add main.ts && git commit -q -m update', { cwd: root });
    await waitFor(() => seen.length === 3);
    expect(seen[2]).toEqual({ files: [] });
    watch.dispose();
  });
});

test('retargets to a new repository and stops publishing the old root', async () => {
  await withRepo(async (first) => {
    await withRepo(async (second) => {
      const seen: DiffSummary[] = [];
      const watch = new GitWatch((summary) => seen.push(summary), 150);
      watch.setRoot(first);
      watch.setRoot(second);

      writeFileSync(path.join(first, 'main.ts'), 'export const answer = 43;\n');
      await Bun.sleep(250);
      expect(seen).toEqual([{ files: [] }, { files: [] }]);

      writeFileSync(path.join(second, 'main.ts'), 'export const answer = 43;\n');
      await waitFor(() => seen.length === 3);
      expect(seen[2]).toEqual({
        files: [{ path: 'main.ts', insertions: 1, deletions: 1 }],
      });
      watch.dispose();
    });
  });
});

test('dispose prevents later watcher callbacks', async () => {
  await withRepo(async (root) => {
    const seen: DiffSummary[] = [];
    const watch = new GitWatch((summary) => seen.push(summary), 150);
    watch.setRoot(root);
    watch.dispose();

    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    await Bun.sleep(250);
    expect(seen).toEqual([{ files: [] }]);
  });
});
