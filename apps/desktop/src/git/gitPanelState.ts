/**
 * Distinguishes a failed summary load from a genuinely empty working tree.
 * Both leave `files.length === 0`; only the error flag separates them.
 */
export type ChangesPaneContent =
  | { type: 'error'; message: string }
  | { type: 'empty' }
  | { type: 'files' };

export function changesPaneContent(error: string | null, fileCount: number): ChangesPaneContent {
  if (fileCount > 0) return { type: 'files' };
  if (error) return { type: 'error', message: error };
  return { type: 'empty' };
}

/** Diff / history panes: prefer the failure over an empty or loading label. */
export type LoadPaneContent =
  | { type: 'error'; message: string }
  | { type: 'empty' }
  | { type: 'ready' };

export function loadPaneContent(error: string | null, hasContent: boolean): LoadPaneContent {
  if (hasContent) return { type: 'ready' };
  if (error) return { type: 'error', message: error };
  return { type: 'empty' };
}
