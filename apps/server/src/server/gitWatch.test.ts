import { expect, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalFixture } from '../../test-paths';
import type { DiffSummary } from './gitDiff';
import { EMPTY_REPO_STATUS } from './gitStatus';
import { GitWatch } from './gitWatch';

const IS_WINDOWS = process.platform === 'win32';

// On Windows, closing a ReadDirectoryChangesW handle only queues the
// cancellation — the directory stays EBUSY briefly after dispose(). Retry.
async function removeFixture(root: string): Promise<void> {
  // ~500ms of headroom in 25ms steps; observed to clear on the first retry.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!IS_WINDOWS || attempt >= 20) throw err;
      await Bun.sleep(25);
    }
  }
}

// Async on purpose: a synchronous shell-out pins the JS thread, so a slow git
// under load prevents bun's per-test timeout from ever firing.
async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`);
}

async function withRepo(fn: (root: string) => void | Promise<void>) {
  const root = canonicalFixture(mkdtempSync(path.join(tmpdir(), 'tether-gitwatch-')));
  try {
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'test');
    writeFileSync(path.join(root, 'main.ts'), 'export const answer = 42;\n');
    await git(root, 'add', 'main.ts');
    await git(root, 'commit', '-q', '-m', 'initial');
    await fn(root);
  } finally {
    await removeFixture(root);
  }
}

// Only the gitignore test below needs the real `git ls-files` ignore-pruning
// spawn; stub it elsewhere so the suite stays deterministic and fast.
const noIgnoredDirs = async () => new Set<string>();

// Windows pays double: git spawns cost 200-380ms under parallel load (vs ~5ms
// on Linux), and event delivery is slower too. 5s isn't enough; 20s is a backstop, not a delay.
const REPO_TEST_TIMEOUT_MS = IS_WINDOWS ? 20_000 : 5_000;

async function waitFor(condition: () => boolean, timeout = IS_WINDOWS ? 8_000 : 2_000) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await Bun.sleep(20);
  expect(condition()).toBe(true);
}

test(
  'debounces native worktree events and suppresses an identical summary',
  async () => {
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
      // Assert on the settled value, not `seen[2]`: how many summaries the
      // add+commit pair produces is a process-spawn timing artifact (Windows can split them).
      await waitFor(() => seen.length > 2 && seen[seen.length - 1].files.length === 0);
      expect(seen[seen.length - 1]).toEqual({ files: [] });
      watch.dispose();
    });
  },
  REPO_TEST_TIMEOUT_MS,
);

test(
  'kick schedules a refresh after an out-of-band index change',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

test(
  'retargets to a new repository and stops publishing the old root',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

test(
  'dispose prevents later watcher callbacks',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

test(
  'captures changes that already existed before setRoot was first called',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

test(
  'does not open a watch inside a gitignored directory (e.g. node_modules)',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

test(
  'logs instead of throwing when a watch cannot be created',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

test(
  'degrades to empty and closes a partial watcher for a non-repository root',
  async () => {
    const root = canonicalFixture(mkdtempSync(path.join(tmpdir(), 'tether-gitwatch-notgit-')));
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
      // What matters is that a non-repo root yields empty summaries, never a diff.
      // The count is not the assertion: one write can surface as several
      // ReadDirectoryChangesW events on Windows, so the callback may fire twice.
      expect(seen.length).toBeGreaterThanOrEqual(1);
      for (const summary of seen) expect(summary).toEqual({ files: [] });
      watch.dispose();
    } finally {
      await removeFixture(root);
    }
  },
  REPO_TEST_TIMEOUT_MS,
);

// The bug behind "cd into another folder is slow": a directory that merely
// contains checkouts is itself a repo with no commits, so git reports nothing
// as ignored and the walk descended into every project — 508k directories and
// ~14s of synchronous blocking on the PTY output path, plus one inotify watch
// per directory. Nested repositories are boundaries for the parent's diff, so
// there was never a reason to look inside them.
test(
  'does not walk into nested repositories',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

// Belt and braces for a tree nobody anticipated: watch less rather than freeze
// the server and exhaust the kernel's inotify allowance. The cap is injectable
// so this exercises the real branch without creating thousands of inodes.
test(
  'stops watching past the directory cap instead of blocking',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

// setRoot is called from the PTY output path, so `cd` waits on whatever it
// does. It must hand back control immediately and set the watch up afterwards:
// the user lands in the new directory first, the diff summary arrives a tick
// later, the working-tree watches fill in behind it.
test(
  'setRoot returns before doing any of the work',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

test(
  'ignored-directory discovery yields the event loop before scanning',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

test(
  'a stale ignored-directory result cannot overwrite the active root',
  async () => {
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
  },
  REPO_TEST_TIMEOUT_MS,
);

// Windows cannot express the premise: node maps chmod onto the read-only
// attribute, so 0o000 leaves the directory perfectly readable and the watcher
// is right to watch it. Real Windows ACLs could deny traversal, but building
// that fixture needs icacls and a second principal — far more machinery than
// the behaviour under test is worth.
test.skipIf(process.platform === 'win32')(
  'skips unreadable directories without attempting a watch',
  async () => {
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
  },
);

/**
 * How long the stand-in "slow git" read takes, and how late the 10ms timer
 * armed alongside it is still allowed to fire.
 *
 * The two scale together, by the same factor, so the property proved is
 * identical on both platforms: the timer must land inside half the read. A read
 * that blocked the event loop — the spawnSync regression this test exists to
 * catch — would push the timer out by the *whole* read, twice the budget,
 * whichever platform it ran on.
 *
 * The factor is 4 on Windows because its timers are coarser and its scheduler
 * preempts more readily: the same 10ms timer measured 11ms idle here, 21-41ms
 * with the box loaded, and 141ms on the run that first failed the flat 100ms
 * budget. Raising only the budget would have been the wrong fix — at 400ms
 * against a 200ms read, a fully blocking read would have passed.
 */
const READ_MS = IS_WINDOWS ? 800 : 200;
const EVENT_BUDGET_MS = IS_WINDOWS ? 400 : 100;

// The whole point of the watcher: a slow repository must cost the diff badge
// its freshness, never the PTY. `git diff` + `git status` + one `git diff
// --no-index` per untracked file used to run through spawnSync on the event
// loop, so a repo where git needs ~1s (e.g. one whose working tree contains
// directories git cannot read) froze every session on the server for that long,
// every debounce, for as long as anything kept writing to it.
test(
  'a slow git read never blocks the event loop',
  async () => {
    await withRepo(async (root) => {
      const seen: DiffSummary[] = [];
      const watcher = new GitWatch(
        (summary) => seen.push(summary),
        20,
        undefined,
        {
          readDiffSummary: async () => {
            await Bun.sleep(READ_MS);
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
        expect(firedAfter).toBeLessThan(EVENT_BUDGET_MS);
        await waitFor(() => seen.length === 1);
        expect(seen[0].files[0]?.path).toBe('slow');
      } finally {
        watcher.dispose();
      }
    });
  },
  REPO_TEST_TIMEOUT_MS,
);

// Reads are single-flight: writes that land while one is in flight collapse into
// exactly one follow-up read, so a busy tree cannot queue up a pile of gits.
test(
  'coalesces changes that arrive while a read is in flight',
  async () => {
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
                {
                  path: `read-${reads}`,
                  insertions: 1,
                  deletions: 0,
                  binary: false,
                  staged: false,
                },
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
        // One in-flight read plus one coalesced follow-up — not five. Windows is
        // allowed one extra: ReadDirectoryChangesW reports a single write as
        // several events, so the 10ms debounce can close twice across the 25ms
        // the five kicks span. The property under test is that kicks coalesce at
        // all, and 3 ≪ 5 still demonstrates it.
        if (process.platform === 'win32') {
          expect(reads).toBeGreaterThanOrEqual(2);
          expect(reads).toBeLessThanOrEqual(3);
        } else {
          expect(reads).toBe(2);
        }
      } finally {
        watcher.dispose();
      }
    });
  },
  REPO_TEST_TIMEOUT_MS,
);
