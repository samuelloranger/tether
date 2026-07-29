import { UTILITY_BAR_PAGES } from './utilityBarModel';

test('utility bar keeps the D-pad page focused on primary terminal controls', () => {
  expect(UTILITY_BAR_PAGES[0]).toEqual(['ctrl', 'tab', 'esc', 'slash', 'dpad', 'paste', 'hide']);
  expect(UTILITY_BAR_PAGES[1]).toEqual(['del', 'home', 'end', 'pgup', 'pgdn', 'image']);
});

// The bar is one fixed-height non-wrapping row, so an unbalanced page clips its
// last controls instead of reflowing onto a second line.
test('utility bar pages stay within one row of controls', () => {
  for (const page of UTILITY_BAR_PAGES) expect(page.length).toBeLessThanOrEqual(7);
});

test('utility bar keys are unique across pages', () => {
  const keys = UTILITY_BAR_PAGES.flat();
  expect(new Set(keys).size).toBe(keys.length);
});
