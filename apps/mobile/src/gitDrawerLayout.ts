export const GIT_DRAWER_MIN_LEFT = 220;
export const GIT_DRAWER_MIN_RIGHT = 320;
export const GIT_DRAWER_DEFAULT_LEFT_RATIO = 1 / 3;

/** Clamp the Changes/History column width so both panes stay usable. */
export function clampGitDrawerLeftWidth(requested: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(requested)) return 0;
  if (total <= GIT_DRAWER_MIN_LEFT + GIT_DRAWER_MIN_RIGHT) {
    return Math.max(0, Math.floor(total / 2));
  }
  return Math.min(
    Math.max(Math.round(requested), GIT_DRAWER_MIN_LEFT),
    total - GIT_DRAWER_MIN_RIGHT,
  );
}

export function defaultGitDrawerLeftWidth(total: number): number {
  return clampGitDrawerLeftWidth(total * GIT_DRAWER_DEFAULT_LEFT_RATIO, total);
}

/**
 * Escape handling for the desktop git drawer.
 * After blurring the commit field, focus often lands on document.body — still dismiss.
 */
export function drawerEscapeAction(opts: {
  inDrawer: boolean;
  isTextField: boolean;
  isDocumentRoot: boolean;
}): 'blur-field' | 'dismiss' | 'ignore' {
  if (opts.inDrawer && opts.isTextField) return 'blur-field';
  if (opts.inDrawer || opts.isDocumentRoot) return 'dismiss';
  return 'ignore';
}
