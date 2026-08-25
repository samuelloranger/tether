// Layout for the mobile utility bar. This IS what UtilityBar renders — each key
// maps to one control in the bar's KEY_RENDERERS table, so adding a key here is
// enough to change the UI.
//
// The bar is a single fixed-height row that never wraps and never scrolls, so
// the key set has to be cut to whatever the viewport can hold. On a phone that
// means two paged halves with an inline pager arrow; on a tablet the whole set
// fits at a comfortable touch size and the pager disappears entirely.

/** Every control, in bar order. The paged split below is a subset of this. */
export const UTILITY_BAR_KEYS = [
  'ctrl',
  'tab',
  'esc',
  'slash',
  'dpad',
  'paste',
  'hide',
  'del',
  'home',
  'end',
  'pgup',
  'pgdn',
  'image',
] as const;

/**
 * The phone fallback. Item counts are balanced (7 + 6) on purpose: each page
 * spends one more slot on its pager arrow. Buttons shrink to a minimum width to
 * keep the pager on-screen on narrow phones, but a page much wider than 7 keys
 * still squeezes past comfortable touch targets. Keep each page around 6-7 keys
 * and prefer short labels — on a narrow phone the widest ones ellipsize.
 */
export const UTILITY_BAR_PAGES = [
  ['ctrl', 'tab', 'esc', 'slash', 'dpad', 'paste', 'hide'],
  ['del', 'home', 'end', 'pgup', 'pgdn', 'image'],
] as const;

export type UtilityBarKey = (typeof UTILITY_BAR_KEYS)[number];

/** Mirrors the UtilityBar stylesheet: `flexBasis` per key, `gap` between them. */
export const UTILITY_KEY_WIDTH = 44;
export const UTILITY_KEY_GAP = 4;

/** Row width needed to give every key its full (unshrunk) touch target. */
export function utilityRowWidth(keyCount: number): number {
  if (keyCount <= 0) return 0;
  return keyCount * UTILITY_KEY_WIDTH + (keyCount - 1) * UTILITY_KEY_GAP;
}

/**
 * Pick the bar layout for the space actually available (viewport width minus
 * gutters and horizontal safe-area insets).
 *
 * Deliberately binary: either every key gets a full-size target on one row, or
 * we fall back to the tuned phone pages. A width-proportional split would
 * reshuffle which keys sit on which page as the iPad rotates or resizes in
 * Split View, and a key that moves under your thumb is worse than a pager.
 */
export function utilityBarPages(availableWidth: number): readonly (readonly UtilityBarKey[])[] {
  if (availableWidth >= utilityRowWidth(UTILITY_BAR_KEYS.length)) return [UTILITY_BAR_KEYS];
  return UTILITY_BAR_PAGES;
}
