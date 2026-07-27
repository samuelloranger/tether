// Page layout for the mobile utility bar. This IS what UtilityBar renders —
// each key maps to one control in the bar's CONTROLS table, so adding a key or
// a page here is enough to change the UI.
//
// Item counts are balanced (6 + 6) on purpose: the bar is a single fixed-height
// row with no wrapping, so a page wider than the screen clips instead of
// reflowing. Keep each page's rendered width under ~340pt (narrowest supported
// phone minus horizontal padding) when editing.
export const UTILITY_BAR_PAGES = [
  ['ctrl', 'tab', 'esc', 'dpad', 'paste', 'hide'],
  ['del', 'home', 'end', 'pgup', 'pgdn', 'image'],
] as const;

export type UtilityBarKey = (typeof UTILITY_BAR_PAGES)[number][number];
