import { expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      { files: [{ path: 'main.ts', insertions: 1, deletions: 1, binary: false, staged: false }] },
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
        files: [{ path: 'main.ts', insertions: 1, deletions: 1, binary: false, staged: false }],
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

test('captures changes that already existed before setRoot was first called', async () => {
  await withRepo(async (root) => {
    // Simulates reconnecting to (or opening) a session whose shell already
    // had a dirty working tree before the client ever attached.
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    writeFileSync(path.join(root, 'fresh.ts'), 'export const x = 1;\n');

    const seen: DiffSummary[] = [];
    const watch = new GitWatch((summary) => seen.push(summary), 50);
    watch.setRoot(root);
    expect(seen).toEqual([
      {
        files: [
          { path: 'main.ts', insertions: 1, deletions: 1, binary: false, staged: false },
          { path: 'fresh.ts', insertions: 1, deletions: 0, binary: false, staged: false },
        ],
      },
    ]);
    watch.dispose();
  });
});

test('does not open a watch inside a gitignored directory (e.g. node_modules)', async () => {
  await withRepo(async (root) => {
    writeFileSync(path.join(root, '.gitignore'), 'ignored_dir/\n');
    execSync('git add .gitignore && git commit -q -m gitignore', { cwd: root });
    mkdirSync(path.join(root, 'ignored_dir', 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'ignored_dir', 'nested', 'file.txt'), 'one\n');

    const watchSpy = spyOn(nodeFs, 'watch');
    const watch = new GitWatch(() => {}, 50);
    watch.setRoot(root);
    await Bun.sleep(50);
    watch.dispose();

    const watchedPaths = watchSpy.mock.calls.map((call) => call[0]);
    expect(watchedPaths.some((p) => String(p).includes('ignored_dir'))).toBe(false);
    expect(watchedPaths.some((p) => String(p) === root)).toBe(true);
    watchSpy.mockRestore();
  });
});

test('logs instead of throwing when a watch cannot be created', async () => {
  await withRepo(async (root) => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const watchSpy = spyOn(nodeFs, 'watch').mockImplementation(() => {
      throw new Error('ENOSPC: System limit for number of file watchers reached');
    });
    try {
      const watch = new GitWatch(() => {}, 50);
      expect(() => watch.setRoot(root)).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
      watch.dispose();
    } finally {
      watchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

test('degrades to empty and closes a partial watcher for a non-repository root', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-gitwatch-notgit-'));
  try {
    const seen: DiffSummary[] = [];
    const watch = new GitWatch((summary) => seen.push(summary), 50);
    watch.setRoot(root);
    writeFileSync(path.join(root, 'plain.txt'), 'changed\n');
    await Bun.sleep(100);
    expect(seen).toEqual([{ files: [] }]);
    watch.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
