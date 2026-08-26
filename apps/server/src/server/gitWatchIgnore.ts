/**
 * Directory basenames the worktree walker should never descend into.
 * git status does not look inside these for meaningful diffs, and watching them
 * burns inotify watches on high-churn trees (node_modules/.old-*, cargo deps).
 */
const SKIP_DIR_NAMES = new Set(['node_modules', 'target', 'dist', '.git']);

export function shouldSkipWatchDirName(name: string): boolean {
  return SKIP_DIR_NAMES.has(name);
}
