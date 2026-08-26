import { expect, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiffSummary } from './gitDiff';
import { EMPTY_REPO_STATUS } from './gitStatus';
import { GitWatch } from './gitWatch';

/**
 * Runs git without blocking the event loop.
 *
 * These tests used to shell out synchronously, which pins the JS thread for the
 * whole call — so when git was slow on a loaded runner, bun's per-test timeout
 * could never fire and the worker simply stopped. On CI that stalled the
 * server-test step indefinitely after every other file had already reported.
 * gitWatch.ts had the same bug in production and moved to Bun.spawn; this test
 * helper kept it.
 */
async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`);
}

async function withRepo(fn: (root: string) => void | Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-gitwatch-'));
  try {
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'test');
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
    await git(root, 'add', 'main.ts');
    await git(root, 'commit', '-q', '-m', 'initial');
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Ignore-pruning spawns a real `git ls-files` per watcher. Only the
// gitignore test below actually needs it, and under `bun test --parallel` the
// extra subprocess per test pushed several past the 5s timeout. Stub it
// everywhere else so the suite is deterministic (and faster).
const noIgnoredDirs = async () => new Set<string>();

async function waitFor(condition: () => boolean, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await Bun.sleep(20);
  expect(condition()).toBe(true);
}

test('debounces native worktree events and suppresses an identical summary', async () => {
  await withRepo(async (root) => {
    const seen: DiffSummary[] = [];
    const watch = new GitWatch(
      (summary) => seen.push(summary),
      150,
      undefined,
      undefined,
      noIgnoredDirs,
    );
    watch.setRoot(root);
    await watch.whenScanned();
    expect(seen).toEqual([{ files: [] }]);

    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 44;\n');
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([
      { files: [] },
      {
        files: [
          {
            path: 'main.ts',
            insertions: 1,
            deletions: 1,
            binary: false,
            staged: false,
            untracked: false,
          },
        ],
      },
    ]);

    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 43;\n');
    await Bun.sleep(250);
    expect(seen).toHaveLength(2);

    await git(root, 'add', 'main.ts');
    await git(root, 'commit', '-q', '-m', 'update');
    await waitFor(() => seen.length === 3);
    expect(seen[2]).toEqual({ files: [] });
    watch.dispose();
  });
});

test('kick schedules a refresh after an out-of-band index change', async () => {
  await withRepo(async (root) => {
    const seen: DiffSummary[] = [];
    const watch = new GitWatch(
      (summary) => seen.push(summary),
      50,
      undefined,
      undefined,
      noIgnoredDirs,
    );
    watch.setRoot(root);
    await watch.whenScanned();
    expect(seen).toEqual([{ files: [] }]);

    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 99;\n');
    await git(root, 'add', 'main.ts');
    // Bypass inotify: HTTP stage/commit path calls kick() after the write.
    watch.kick();
    await waitFor(() => seen.length === 2);
    expect(seen[1]).toEqual({
      files: [
        {
          path: 'main.ts',
          insertions: 1,
          deletions: 1,
          binary: false,
          staged: true,
          untracked: false,
        },
      ],
    });
    watch.dispose();
  });
});

test('retargets to a new repository and stops publishing the old root', async () => {
  await withRepo(async (first) => {
    await withRepo(async (second) => {
      const seen: DiffSummary[] = [];
      const watch = new GitWatch(
        (summary) => seen.push(summary),
        150,
        undefined,
        undefined,
        noIgnoredDirs,
      );
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
        files: [
          {
            path: 'main.ts',
            insertions: 1,
            deletions: 1,
            binary: false,
            staged: false,
            untracked: false,
          },
        ],
      });
      watch.dispose();
    });
  });
});

test('dispose prevents later watcher callbacks', async () => {
  await withRepo(async (root) => {
    const seen: DiffSummary[] = [];
    const watch = new GitWatch(
      (summary) => seen.push(summary),
      150,
      undefined,
      undefined,
      noIgnoredDirs,
    );
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
    const watch = new GitWatch(
      (summary) => seen.push(summary),
      50,
      undefined,
      undefined,
      noIgnoredDirs,
    );
    watch.setRoot(root);
    await watch.whenScanned();
    expect(seen).toEqual([
      {
        files: [
          {
            path: 'main.ts',
            insertions: 1,
            deletions: 1,
            binary: false,
            staged: false,
            untracked: false,
          },
          {
            path: 'fresh.ts',
            insertions: 1,
            deletions: 0,
            binary: false,
            staged: false,
            untracked: true,
          },
        ],
      },
    ]);
    watch.dispose();
  });
});

test('does not open a watch inside a gitignored directory (e.g. node_modules)', async () => {
  await withRepo(async (root) => {
    writeFileSync(path.join(root, '.gitignore'), 'ignored_dir/\n');
    await git(root, 'add', '.gitignore');
    await git(root, 'commit', '-q', '-m', 'gitignore');
    mkdirSync(path.join(root, 'ignored_dir', 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'ignored_dir', 'nested', 'file.txt'), 'one\n');

    const watchSpy = spyOn(nodeFs, 'watch');
    // Deliberately the real reader: this test is what covers ignore-pruning.
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
      const watch = new GitWatch(() => {}, 50, undefined, undefined, noIgnoredDirs);
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
    const watch = new GitWatch(
      (summary) => seen.push(summary),
      50,
      undefined,
      undefined,
      noIgnoredDirs,
    );
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
    await git(nested, 'init', '-q');
    mkdirSync(path.join(nested, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(path.join(parent, 'src'));

    const watched: string[] = [];
    const spy = spyOn(nodeFs, 'watch').mockImplementation(((dir: string) => {
      watched.push(String(dir));
      return { close() {} } as unknown as nodeFs.FSWatcher;
    }) as typeof nodeFs.watch);

    const watcher = new GitWatch(() => {}, 150, undefined, undefined, noIgnoredDirs);
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

    const watcher = new GitWatch(() => {}, 150, 5, undefined, noIgnoredDirs);
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
    const watcher = new GitWatch(
      (summary) => seen.push(summary),
      150,
      undefined,
      undefined,
      noIgnoredDirs,
    );
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
    const watcher = new GitWatch(() => {}, 50, undefined, undefined, noIgnoredDirs);
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
    const watcher = new GitWatch(
      (summary) => seen.push(summary),
      20,
      undefined,
      {
        readDiffSummary: async () => {
          await Bun.sleep(200);
          return {
            files: [{ path: 'slow', insertions: 1, deletions: 0, binary: false, staged: false }],
          };
        },
        readRepoStatus: async () => EMPTY_REPO_STATUS,
      },
      noIgnoredDirs,
    );
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
    const watcher = new GitWatch(
      () => {},
      10,
      undefined,
      {
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
      },
      noIgnoredDirs,
    );
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
