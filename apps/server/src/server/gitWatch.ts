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

  constructor(
    private readonly onChange: (summary: DiffSummary) => void,
    private readonly debounceMs = 150,
    private readonly maxWatchedDirs = MAX_WATCHED_DIRS,
  ) {}

  setRoot(root: string | null) {
    if (this.disposed || root === this.root) return;
    this.closeHandles();
    this.root = root;
    this.lastSummary = null;

    if (root) {
      this.ignoredDirs = listIgnoredDirs(root);
      this.truncated = false;
      this.walk(root, root);
      if (this.truncated) {
        console.warn(
          `tether: "${root}" has more than ${this.maxWatchedDirs} directories to watch; ` +
            'working-tree changes below the watched subset will only appear on the next git event.',
        );
      }
      try {
        this.addHandle(watch(resolveGitDir(root), { recursive: true }, this.schedule));
      } catch (err) {
        console.warn(`tether: could not watch git dir for "${root}":`, err);
      }
    }
    this.refresh();
  }

  // Manual recursive walk (instead of node:fs's {recursive:true}) so ignored
  // directories can be pruned from the traversal entirely — see
  // listIgnoredDirs above for why that matters.
  private walk(root: string, dir: string) {
    if (this.watchedDirs.size >= this.maxWatchedDirs) {
      this.truncated = true;
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
      this.walk(root, child);
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
        if (isDir) this.walk(root, child);
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
