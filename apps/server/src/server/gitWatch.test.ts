import { expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiffSummary } from './gitDiff';
import { EMPTY_REPO_STATUS } from './gitStatus';
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
    await watch.whenScanned();
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

test('kick schedules a refresh after an out-of-band index change', async () => {
  await withRepo(async (root) => {
    const seen: DiffSummary[] = [];
    const watch = new GitWatch((summary) => seen.push(summary), 50);
    watch.setRoot(root);
    await watch.whenScanned();
    expect(seen).toEqual([{ files: [] }]);

    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 99;\n');
    execSync('git add main.ts', { cwd: root });
    // Bypass inotify: HTTP stage/commit path calls kick() after the write.
    watch.kick();
    await waitFor(() => seen.length === 2);
    expect(seen[1]).toEqual({
      files: [{ path: 'main.ts', insertions: 1, deletions: 1, binary: false, staged: true }],
    });
    watch.dispose();
  });
});

test('retargets to a new repository and stops publishing the old root', async () => {
  await withRepo(async (first) => {
    await withRepo(async (second) => {
      const seen: DiffSummary[] = [];
      const watch = new GitWatch((summary) => seen.push(summary), 150);
      watch.setRoot(first);
      // Retargeted before the deferred scan for `first` ever ran, so `first` is
      // never scanned and never published — two quick `cd`s cost one scan.
      watch.setRoot(second);
      await watch.whenScanned();

      writeFileSync(path.join(first, 'main.ts'), 'export const answer = 43;\n');
      await Bun.sleep(250);
      expect(seen).toEqual([{ files: [] }]);

      writeFileSync(path.join(second, 'main.ts'), 'export const answer = 43;\n');
      await waitFor(() => seen.length === 2);
      expect(seen[1]).toEqual({
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
    await watch.whenScanned();
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
    await watch.whenScanned();
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
    await watch.whenScanned();
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
      await watch.whenScanned();
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
    await watch.whenScanned();
    writeFileSync(path.join(root, 'plain.txt'), 'changed\n');
    await Bun.sleep(100);
    expect(seen).toEqual([{ files: [] }]);
    watch.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The bug behind "cd into another folder is slow": a directory that merely
// contains checkouts is itself a repo with no commits, so git reports nothing
// as ignored and the walk descended into every project — 508k directories and
// ~14s of synchronous blocking on the PTY output path, plus one inotify watch
// per directory. Nested repositories are boundaries for the parent's diff, so
// there was never a reason to look inside them.
test('does not walk into nested repositories', async () => {
  await withRepo(async (parent) => {
    const nested = path.join(parent, 'child-repo');
    mkdirSync(nested);
    execSync('git init -q', { cwd: nested });
    mkdirSync(path.join(nested, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(path.join(parent, 'src'));

    const watched: string[] = [];
    const spy = spyOn(nodeFs, 'watch').mockImplementation(((dir: string) => {
      watched.push(String(dir));
      return { close() {} } as unknown as nodeFs.FSWatcher;
    }) as typeof nodeFs.watch);

    const watcher = new GitWatch(() => {}, 150);
    try {
      watcher.setRoot(parent);
      await watcher.whenScanned();
      expect(watched).toContain(path.join(parent, 'src'));
      expect(watched.some((dir) => dir.startsWith(nested))).toBe(false);
    } finally {
      watcher.dispose();
      spy.mockRestore();
    }
  });
});

// Belt and braces for a tree nobody anticipated: watch less rather than freeze
// the server and exhaust the kernel's inotify allowance. The cap is injectable
// so this exercises the real branch without creating thousands of inodes.
test('stops watching past the directory cap instead of blocking', async () => {
  await withRepo(async (root) => {
    let dir = root;
    for (let i = 0; i < 20; i++) dir = path.join(dir, `d${i}`);
    mkdirSync(dir, { recursive: true });

    const watched: string[] = [];
    const spy = spyOn(nodeFs, 'watch').mockImplementation(((target: string) => {
      watched.push(String(target));
      return { close() {} } as unknown as nodeFs.FSWatcher;
    }) as typeof nodeFs.watch);

    const watcher = new GitWatch(() => {}, 150, 5);
    try {
      watcher.setRoot(root);
      await watcher.whenScanned();
      // 5 working-tree dirs, plus the separate recursive watch on .git.
      expect(watched.filter((target) => !target.endsWith('.git'))).toHaveLength(5);
      expect(watched).toContain(root);
    } finally {
      watcher.dispose();
      spy.mockRestore();
    }
  });
});

// setRoot is called from the PTY output path, so `cd` waits on whatever it
// does. It must hand back control immediately and set the watch up afterwards:
// the user lands in the new directory first, the diff summary arrives a tick
// later, the working-tree watches fill in behind it.
test('setRoot returns before doing any of the work', async () => {
  await withRepo(async (root) => {
    for (let i = 0; i < 40; i++) {
      mkdirSync(path.join(root, `dir-${i}`, 'nested', 'deeper'), { recursive: true });
    }

    const seen: DiffSummary[] = [];
    const watcher = new GitWatch((summary) => seen.push(summary), 150);
    try {
      const start = performance.now();
      watcher.setRoot(root);
      const blocked = performance.now() - start;

      // Nothing has happened yet: no git subprocess, no readdir, no summary.
      expect(seen).toEqual([]);
      expect(blocked).toBeLessThan(5);

      await watcher.whenScanned();
      expect(seen).toEqual([{ files: [] }]);
    } finally {
      watcher.dispose();
    }
  });
});

test('ignored-directory discovery yields the event loop before scanning', async () => {
  await withRepo(async (root) => {
    let releaseIgnored!: (dirs: Set<string>) => void;
    const ignored = new Promise<Set<string>>((resolve) => {
      releaseIgnored = resolve;
    });
    const watcher = new GitWatch(
      () => {},
      150,
      undefined,
      {
        readDiffSummary: async () => ({ files: [] }),
        readRepoStatus: async () => EMPTY_REPO_STATUS,
      },
      () => ignored,
    );
    try {
      watcher.setRoot(root);
      let settled = false;
      void watcher.whenScanned().then(() => {
        settled = true;
      });

      let timerFired = false;
      setTimeout(() => {
        timerFired = true;
      }, 10);
      await Bun.sleep(50);
      expect(timerFired).toBe(true);
      expect(settled).toBe(false);

      releaseIgnored(new Set());
      await watcher.whenScanned();
      expect(settled).toBe(true);
    } finally {
      releaseIgnored(new Set());
      watcher.dispose();
    }
  });
});

test('a stale ignored-directory result cannot overwrite the active root', async () => {
  await withRepo(async (first) => {
    await withRepo(async (second) => {
      const pending = new Map<string, (dirs: Set<string>) => void>();
      const watcher = new GitWatch(
        () => {},
        150,
        undefined,
        {
          readDiffSummary: async () => ({ files: [] }),
          readRepoStatus: async () => EMPTY_REPO_STATUS,
        },
        (root) =>
          new Promise<Set<string>>((resolve) => {
            pending.set(root, resolve);
          }),
      );
      try {
        watcher.setRoot(first);
        await waitFor(() => pending.has(first));
        watcher.setRoot(second);
        await waitFor(() => pending.has(second));

        const activeIgnored = path.join(second, 'ignored');
        pending.get(second)!(new Set([activeIgnored]));
        await watcher.whenScanned();
        pending.get(first)!(new Set());
        await Bun.sleep(20);

        const state = watcher as unknown as { ignoredDirs: Set<string> };
        expect(state.ignoredDirs).toEqual(new Set([activeIgnored]));
      } finally {
        pending.get(first)?.(new Set());
        pending.get(second)?.(new Set());
        watcher.dispose();
      }
    });
  });
});

test('skips unreadable directories without attempting a watch', async () => {
  await withRepo(async (root) => {
    const locked = path.join(root, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const watchSpy = spyOn(nodeFs, 'watch');
    const watcher = new GitWatch(() => {}, 50);
    try {
      watcher.setRoot(root);
      await watcher.whenScanned();
      const watchedPaths = watchSpy.mock.calls.map((call) => String(call[0]));
      expect(watchedPaths).not.toContain(locked);
      expect(warnSpy.mock.calls.some((call) => call.map(String).join(' ').includes(locked))).toBe(
        false,
      );
    } finally {
      chmodSync(locked, 0o700);
      watcher.dispose();
      watchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// The whole point of the watcher: a slow repository must cost the diff badge
// its freshness, never the PTY. `git diff` + `git status` + one `git diff
// --no-index` per untracked file used to run through spawnSync on the event
// loop, so a repo where git needs ~1s (e.g. one whose working tree contains
// directories git cannot read) froze every session on the server for that long,
// every debounce, for as long as anything kept writing to it.
test('a slow git read never blocks the event loop', async () => {
  await withRepo(async (root) => {
    const seen: DiffSummary[] = [];
    const watcher = new GitWatch((summary) => seen.push(summary), 20, undefined, {
      readDiffSummary: async () => {
        await Bun.sleep(200);
        return {
          files: [{ path: 'slow', insertions: 1, deletions: 0, binary: false, staged: false }],
        };
      },
      readRepoStatus: async () => EMPTY_REPO_STATUS,
    });
    try {
      watcher.setRoot(root);
      // A timer armed while the read is in flight must still fire on time.
      const armed = performance.now();
      let firedAfter = Number.NaN;
      const timer = new Promise<void>((resolve) => {
        setTimeout(() => {
          firedAfter = performance.now() - armed;
          resolve();
        }, 10);
      });
      await timer;
      expect(firedAfter).toBeLessThan(100);
      await waitFor(() => seen.length === 1);
      expect(seen[0].files[0]?.path).toBe('slow');
    } finally {
      watcher.dispose();
    }
  });
});

// Reads are single-flight: writes that land while one is in flight collapse into
// exactly one follow-up read, so a busy tree cannot queue up a pile of gits.
test('coalesces changes that arrive while a read is in flight', async () => {
  await withRepo(async (root) => {
    let reads = 0;
    const watcher = new GitWatch(() => {}, 10, undefined, {
      readDiffSummary: async () => {
        reads++;
        await Bun.sleep(120);
        return {
          files: [
            { path: `read-${reads}`, insertions: 1, deletions: 0, binary: false, staged: false },
          ],
        };
      },
      readRepoStatus: async () => EMPTY_REPO_STATUS,
    });
    try {
      watcher.setRoot(root);
      await waitFor(() => reads === 1);
      for (let i = 0; i < 5; i++) {
        watcher.kick();
        await Bun.sleep(5);
      }
      await Bun.sleep(400);
      // One in-flight read plus one coalesced follow-up — not five.
      expect(reads).toBe(2);
    } finally {
      watcher.dispose();
    }
  });
});
