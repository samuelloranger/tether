import { expect, test } from 'bun:test';
import { clampFontSize } from './useTerminalViewport';

test('clampFontSize keeps terminal fonts within the supported range', () => {
  expect(clampFontSize(7)).toBe(8);
  expect(clampFontSize(11)).toBe(11);
  expect(clampFontSize(25)).toBe(24);
});
