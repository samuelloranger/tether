import {
  UTILITY_BAR_KEYS,
  UTILITY_BAR_PAGES,
  utilityBarPages,
  utilityRowWidth,
} from './utilityBarModel';

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

test('the paged fallback covers every key exactly once, in bar order', () => {
  expect(UTILITY_BAR_PAGES.flat()).toEqual([...UTILITY_BAR_KEYS]);
});

describe('utilityBarPages', () => {
  const fullRow = utilityRowWidth(UTILITY_BAR_KEYS.length);

  test('a phone-width bar stays paginated', () => {
    // iPhone 16 Pro portrait, minus the bar's 8px gutters.
    expect(utilityBarPages(402 - 16)).toEqual(UTILITY_BAR_PAGES);
    expect(utilityBarPages(fullRow - 1)).toEqual(UTILITY_BAR_PAGES);
  });

  test('a tablet-width bar shows every key on one unpaginated row', () => {
    // iPad mini portrait is the narrowest tablet we care about.
    const pages = utilityBarPages(744 - 16);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual(UTILITY_BAR_KEYS);
    expect(utilityBarPages(fullRow)).toHaveLength(1);
  });

  test('every key keeps a full 44pt touch target on the single row', () => {
    // 13 keys * 44 + 12 gaps * 4 = 620 — under iPad mini portrait's usable width.
    expect(fullRow).toBe(620);
    expect(fullRow).toBeLessThanOrEqual(744 - 16);
  });

  test('an iPad in a narrow Split View falls back to the phone pages', () => {
    expect(utilityBarPages(375 - 16)).toEqual(UTILITY_BAR_PAGES);
  });
});
