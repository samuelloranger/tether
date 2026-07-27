import { spawnSync } from 'node:child_process';
import { existsSync, type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { type DiffSummary, EMPTY_DIFF_SUMMARY, GitDiffError, readDiffSummary } from './gitDiff';
import { resolveGitDir } from './gitRoot';

// Directories git itself never has to look inside of when diffing/statusing —
// the working-tree half of the watch skips these instead of handing the bare
// root to node:fs's {recursive:true}, which has no notion of .gitignore and
// will open one inotify watch per directory under node_modules/dist/build/etc.
// A real repo's tree (this one: ~21.8k dirs incl. node_modules vs ~4.6k
// tracked) blows past Linux's default fs.inotify.max_user_watches (8192)
// long before anything worth watching is even covered.
function listIgnoredDirs(root: string): Set<string> {
  const result = spawnSync(
    'git',
    [
      '-C',
      root,
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '--no-empty-directory',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return new Set();
  return new Set(
    result.stdout
      .split('\0')
      .filter(Boolean)
      .map((rel) => path.join(root, rel.replace(/\/$/, ''))),
  );
}

// Hard ceiling on watched directories. Ignore-pruning plus the nested-repo
// boundary keeps a normal project far below this; the cap only exists so a tree
// nobody anticipated degrades into "watch less" instead of freezing the server
// and exhausting the kernel's inotify allowance (one watch per directory,
// default limit 8192 on many systems).
const MAX_WATCHED_DIRS = 4096;

// How long one scan slice may hold the event loop. The scan runs in slices
// because setRoot is called from the PTY output path: `cd` must not wait on it.
const SCAN_SLICE_MS = 8;

// A directory with its own .git is a separate repository (or a submodule):
// the parent's diff treats it as an opaque entry.
function isNestedRepo(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

export class GitWatch {
  private root: string | null | undefined;
  private handles: FSWatcher[] = [];
  private watchedDirs = new Set<string>();
  private ignoredDirs = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private lastSummary: DiffSummary | null = null;
  private disposed = false;
  private truncated = false;
  // Directories still to visit, and a generation stamp so a scan still in
  // flight when the root changes (another `cd`) abandons its remaining work.
  private queue: string[] = [];
  private scanGen = 0;
  private scanTimer?: ReturnType<typeof setTimeout>;
  // Resolves when the deferred scan for the current root has finished placing
  // its watches. Nothing in the server waits on it — it exists so tests can
  // assert on the finished state instead of racing the slices.
  private settled: Promise<void> = Promise.resolve();
  private settle: () => void = () => {};

  constructor(
    private readonly onChange: (summary: DiffSummary) => void,
    private readonly debounceMs = 150,
    private readonly maxWatchedDirs = MAX_WATCHED_DIRS,
  ) {}

  // Returns immediately. This is called from the PTY output path in pty.ts, so
  // anything expensive here stalls the terminal the user just typed `cd` into —
  // and every other session with it, since it is one event loop. Setting up the
  // watch is therefore deferred and time-sliced: the user lands in the new
  // directory first, the diff summary arrives a tick later, and the working-tree
  // watches fill in behind it.
  setRoot(root: string | null) {
    if (this.disposed || root === this.root) return;
    this.cancelScan();
    this.closeHandles();
    this.root = root;
    this.lastSummary = null;
    this.truncated = false;

    if (!root) {
      this.refresh();
      return;
    }
    this.settled = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    const gen = ++this.scanGen;
    this.scanTimer = setTimeout(() => this.beginScan(root, gen), 0);
  }

  // First slice: the cheap-but-blocking setup, then publish the diff summary
  // before walking, because the summary is the part the user actually sees.
  /** Awaits the deferred scan for the current root (tests). */
  whenScanned(): Promise<void> {
    return this.settled;
  }

  private beginScan(root: string, gen: number) {
    this.scanTimer = undefined;
    if (this.disposed || gen !== this.scanGen) return;
    this.ignoredDirs = listIgnoredDirs(root);
    try {
      this.addHandle(watch(resolveGitDir(root), { recursive: true }, this.schedule));
    } catch (err) {
      console.warn(`tether: could not watch git dir for "${root}":`, err);
    }
    this.refresh();
    this.queue = [root];
    this.scanSlice(root, gen);
  }

  private scanSlice = (root: string, gen: number) => {
    this.scanTimer = undefined;
    if (this.disposed || gen !== this.scanGen) return;
    const deadline = Date.now() + SCAN_SLICE_MS;
    while (this.queue.length > 0 && Date.now() < deadline) {
      const dir = this.queue.shift();
      if (dir) this.visit(root, dir);
    }
    if (this.queue.length > 0) {
      this.scanTimer = setTimeout(() => this.scanSlice(root, gen), 0);
      return;
    }
    if (this.truncated) {
      console.warn(
        `tether: "${root}" has more than ${this.maxWatchedDirs} directories to watch; ` +
          'working-tree changes below the watched subset will only appear on the next git event.',
      );
    }
    this.settle();
  };

  private cancelScan() {
    this.scanGen++;
    this.queue = [];
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    this.settle(); // never leave an awaited scan hanging
  }

  // One directory per call, queueing its children (instead of node:fs's
  // {recursive:true}) so ignored directories can be pruned from the traversal
  // entirely — see listIgnoredDirs above for why that matters — and so the scan
  // can be interrupted between directories.
  private visit(root: string, dir: string) {
    if (this.watchedDirs.size >= this.maxWatchedDirs) {
      this.truncated = true;
      this.queue = [];
      return;
    }
    this.watchDir(root, dir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.git') continue;
      const child = path.join(dir, name);
      if (this.ignoredDirs.has(child)) continue;
      let isDir = false;
      try {
        isDir = statSync(child).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      // A nested repository is a boundary. `git status` in the parent reports
      // the whole directory as one entry and never looks inside, so watching
      // its contents cannot change this repo's diff — it only costs watches.
      // Skipping it matters: a directory that merely *contains* checkouts (no
      // commits of its own, so nothing is ignored) otherwise drags every
      // project's node_modules into the walk. Measured at 508k directories and
      // ~14s of blocking on one such tree, which is what made `cd` hang.
      if (isNestedRepo(child)) continue;
      this.queue.push(child);
    }
  }

  private watchDir(root: string, dir: string) {
    if (this.watchedDirs.has(dir)) return;
    this.watchedDirs.add(dir);
    try {
      const handle = watch(dir, { recursive: false }, (_event, filename) => {
        this.schedule();
        if (!filename) return;
        // A newly created subdirectory needs its own watch — non-recursive
        // watches don't pick up anything below the directory they're on.
        const child = path.join(dir, filename);
        if (child === path.join(root, '.git') || this.ignoredDirs.has(child)) return;
        let isDir: boolean;
        try {
          isDir = statSync(child).isDirectory();
        } catch {
          return; // deleted/renamed away
        }
        if (!isDir) return;
        // A whole tree can appear at once (a clone, an install). Queue it so it
        // is scanned in slices like any other, never in one blocking burst.
        this.queue.push(child);
        if (!this.scanTimer && this.root === root) {
          const gen = this.scanGen;
          this.scanTimer = setTimeout(() => this.scanSlice(root, gen), 0);
        }
      });
      this.addHandle(handle);
    } catch (err) {
      console.warn(`tether: could not watch "${dir}" for git changes:`, err);
    }
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.cancelScan();
    this.closeHandles();
  }

  private schedule = () => {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.refresh, this.debounceMs);
  };

  private refresh = () => {
    this.timer = undefined;
    if (this.disposed) return;
    let summary = EMPTY_DIFF_SUMMARY;
    if (this.root) {
      try {
        summary = readDiffSummary(this.root);
      } catch (error) {
        if (!(error instanceof GitDiffError)) return;
      }
    }
    if (JSON.stringify(summary.files) === JSON.stringify(this.lastSummary?.files)) return;
    this.lastSummary = summary;
    this.onChange(summary);
  };

  private closeHandles() {
    for (const handle of this.handles) handle.close();
    this.handles = [];
    this.watchedDirs.clear();
  }

  private addHandle(handle: FSWatcher) {
    this.handles.push(handle);
    handle.on('error', (err) => {
      if (this.disposed) return;
      console.warn(`tether: git watch for "${this.root}" died:`, err);
      this.closeHandles();
      this.root = null;
      this.lastSummary = null;
      this.refresh();
    });
  }
}
