import { describe, expect, test } from 'bun:test';
import { HOLD_POPUP_ALT_THRESHOLD, resolveHoldPopupSelection } from './holdPopupKeyModel';

describe('resolveHoldPopupSelection', () => {
  test('stays on the base key below threshold', () => {
    expect(resolveHoldPopupSelection(0)).toBe(false);
    expect(resolveHoldPopupSelection(HOLD_POPUP_ALT_THRESHOLD)).toBe(false);
  });

  test('selects the alt once the finger slides past threshold', () => {
    expect(resolveHoldPopupSelection(HOLD_POPUP_ALT_THRESHOLD + 1)).toBe(true);
    expect(resolveHoldPopupSelection(100)).toBe(true);
  });

  test('never selects alt when the finger moves down instead of up', () => {
    expect(resolveHoldPopupSelection(-50)).toBe(false);
  });
});
