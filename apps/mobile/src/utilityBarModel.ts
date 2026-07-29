// Page layout for the mobile utility bar. This IS what UtilityBar renders —
// each key maps to one control in the bar's CONTROLS table, so adding a key or
// a page here is enough to change the UI.
//
// Item counts are balanced (7 + 6) on purpose. The bar is a single fixed-height
// row with no wrapping and no scrolling, and each page spends one more slot on
// its inline pager arrow. Buttons shrink down to a minimum width to keep the
// pager on-screen on narrow phones, but a page much wider than 7 keys will
// still squeeze past comfortable touch targets. Keep each page around 6-7
// keys, and prefer short labels — on a narrow phone the widest ones ellipsize.
export const UTILITY_BAR_PAGES = [
  ['ctrl', 'tab', 'esc', 'slash', 'dpad', 'paste', 'hide'],
  ['del', 'home', 'end', 'pgup', 'pgdn', 'image'],
] as const;

export type UtilityBarKey = (typeof UTILITY_BAR_PAGES)[number][number];
