import {
  accessSync,
  constants,
  existsSync,
  type FSWatcher,
  readdirSync,
  statSync,
  watch,
} from 'node:fs';
import path from 'node:path';
import {
  type DiffSummary,
  EMPTY_DIFF_SUMMARY,
  GitDiffError,
  readDiffSummaryAsync,
} from './gitDiff';
import { resolveGitDir } from './gitRoot';
import { EMPTY_REPO_STATUS, type RepoStatus, readRepoStatusAsync } from './gitStatus';
import { shouldSkipWatchDirName } from './gitWatchIgnore';
import { logWarn } from './log';

// Directories git itself never has to look inside of when diffing/statusing —
// the working-tree half of the watch skips these instead of handing the bare
// root to node:fs's {recursive:true}, which has no notion of .gitignore and
// will open one inotify watch per directory under node_modules/dist/build/etc.
// A real repo's tree (this one: ~21.8k dirs incl. node_modules vs ~4.6k
// tracked) blows past Linux's default fs.inotify.max_user_watches (8192)
// long before anything worth watching is even covered.
async function listIgnoredDirs(root: string): Promise<Set<string>> {
  const process = Bun.spawn(
    [
      'git',
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
    { stdout: 'pipe', stderr: 'ignore' },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  if (exitCode !== 0) return new Set();
  return new Set(
    stdout
      .split('\0')
      .filter(Boolean)
      .map((rel) => path.join(root, rel.replace(/\/$/, ''))),
  );
}

function isEacces(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EACCES';
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

/** The two git reads the watcher publishes, injectable so tests can slow them down. */
export type GitWatchReaders = {
  readDiffSummary: (root: string) => Promise<DiffSummary>;
  readRepoStatus: (root: string) => Promise<RepoStatus>;
};

const DEFAULT_READERS: GitWatchReaders = {
  readDiffSummary: readDiffSummaryAsync,
  readRepoStatus: readRepoStatusAsync,
};

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
  // Root-owned docker volumes etc. fail every time — remember and stop retrying.
  private inaccessibleDirs = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private lastSummary: DiffSummary | null = null;
  private lastStatus: RepoStatus | null = null;
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

  // A read in flight, and whether anything changed while it ran.
  private reading = false;
  private readAgain = false;
  private current: Promise<void> = Promise.resolve();

  constructor(
    private readonly onChange: (summary: DiffSummary, status: RepoStatus) => void,
    private readonly debounceMs = 150,
    private readonly maxWatchedDirs = MAX_WATCHED_DIRS,
    private readonly readers: GitWatchReaders = DEFAULT_READERS,
    private readonly readIgnoredDirs: (root: string) => Promise<Set<string>> = listIgnoredDirs,
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
    this.lastStatus = null;
    this.truncated = false;

    if (!root) {
      this.refresh();
      return;
    }
    this.settled = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    const gen = ++this.scanGen;
    this.scanTimer = setTimeout(() => void this.beginScan(root, gen), 0);
  }

  // First slice: the cheap-but-blocking setup, then publish the diff summary
  // before walking, because the summary is the part the user actually sees.
  /** Awaits the deferred scan and any git read still in flight (tests). */
  async whenScanned(): Promise<void> {
    await this.settled;
    // Reads are async now, and a coalesced follow-up can start as one ends —
    // drain until the watcher is genuinely idle.
    while (this.reading) await this.current;
  }

  private async beginScan(root: string, gen: number): Promise<void> {
    this.scanTimer = undefined;
    if (this.disposed || gen !== this.scanGen) return;
    let ignoredDirs: Set<string>;
    try {
      ignoredDirs = await this.readIgnoredDirs(root);
    } catch {
      ignoredDirs = new Set();
    }
    if (this.disposed || gen !== this.scanGen) return;
    this.ignoredDirs = ignoredDirs;
    try {
      this.addHandle(watch(resolveGitDir(root), { recursive: true }, this.schedule));
    } catch (err) {
      logWarn(`tether: could not watch git dir for "${root}":`, err);
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
      logWarn(
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
    if (this.inaccessibleDirs.has(dir)) return;
    if (!this.ensureReadable(dir)) return;
    this.watchDir(root, dir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if (isEacces(err)) this.inaccessibleDirs.add(dir);
      return;
    }
    for (const name of names) {
      if (shouldSkipWatchDirName(name)) continue;
      const child = path.join(dir, name);
      if (this.ignoredDirs.has(child) || this.inaccessibleDirs.has(child)) continue;
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

  private ensureReadable(dir: string): boolean {
    try {
      accessSync(dir, constants.R_OK | constants.X_OK);
      return true;
    } catch (err) {
      if (isEacces(err)) this.inaccessibleDirs.add(dir);
      return false;
    }
  }

  private watchDir(root: string, dir: string) {
    if (this.watchedDirs.has(dir) || this.inaccessibleDirs.has(dir)) return;
    this.watchedDirs.add(dir);
    try {
      const handle = watch(dir, { recursive: false }, (_event, filename) => {
        this.schedule();
        if (!filename) return;
        // A newly created subdirectory needs its own watch — non-recursive
        // watches don't pick up anything below the directory they're on.
        if (shouldSkipWatchDirName(filename)) return;
        const child = path.join(dir, filename);
        if (this.ignoredDirs.has(child) || this.inaccessibleDirs.has(child)) return;
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
      if (isEacces(err)) this.inaccessibleDirs.add(dir);
      logWarn(`tether: could not watch "${dir}" for git changes:`, err);
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

  /** Force a debounced re-read (e.g. after HTTP stage/commit). */
  kick() {
    this.schedule();
  }

  // Single-flight: a busy tree fires events far faster than git can answer, and
  // piling reads on top of each other only starves the loop further. Anything
  // that lands mid-read collapses into exactly one follow-up.
  private refresh = () => {
    this.timer = undefined;
    if (this.disposed) return;
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    this.current = this.read().finally(() => {
      this.reading = false;
      if (this.disposed || !this.readAgain) return;
      this.readAgain = false;
      this.refresh();
    });
    void this.current;
  };

  private async read(): Promise<void> {
    const root = this.root;
    const gen = this.scanGen;
    let summary = EMPTY_DIFF_SUMMARY;
    let status = EMPTY_REPO_STATUS;
    if (root) {
      try {
        summary = await this.readers.readDiffSummary(root);
      } catch (error) {
        if (!(error instanceof GitDiffError)) return;
      }
      try {
        status = await this.readers.readRepoStatus(root);
      } catch {
        status = EMPTY_REPO_STATUS;
      }
    }
    // The root can change (another `cd`) or the watch can be disposed while git
    // is running — publishing then would label one repo's diff with another's.
    if (this.disposed || this.root !== root || this.scanGen !== gen) return;
    const sameSummary = JSON.stringify(summary.files) === JSON.stringify(this.lastSummary?.files);
    const sameStatus = JSON.stringify(status) === JSON.stringify(this.lastStatus);
    if (sameSummary && sameStatus) return;
    this.lastSummary = summary;
    this.lastStatus = status;
    this.onChange(summary, status);
  }

  private closeHandles() {
    for (const handle of this.handles) handle.close();
    this.handles = [];
    this.watchedDirs.clear();
  }

  private addHandle(handle: FSWatcher) {
    this.handles.push(handle);
    handle.on('error', (err) => {
      if (this.disposed) return;
      logWarn(`tether: git watch for "${this.root}" died:`, err);
      this.closeHandles();
      this.root = null;
      this.lastSummary = null;
      this.lastStatus = null;
      this.refresh();
    });
  }
}
