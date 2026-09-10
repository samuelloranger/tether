export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Prefix for the split/close accelerators. The handler (App.tsx keydown) fires
 *  on Cmd (mac) or Ctrl+Shift (elsewhere), so the label matches per platform. */
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+Shift+';
