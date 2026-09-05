// Directory basenames the worktree walker should never descend into: git status
// finds nothing meaningful in them, and watching burns inotify watches on high-churn trees.
const SKIP_DIR_NAMES = new Set(['node_modules', 'target', 'dist', '.git']);

export function shouldSkipWatchDirName(name: string): boolean {
  return SKIP_DIR_NAMES.has(name);
}
