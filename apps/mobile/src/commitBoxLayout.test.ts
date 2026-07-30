import { expect, test } from 'bun:test';
import { menuAboveAnchor } from './commitBoxLayout';

test('menuAboveAnchor right-aligns above the chevron and clamps into the window', () => {
  expect(
    menuAboveAnchor({ x: 400, y: 900, width: 36, height: 44 }, { width: 1200, height: 1000 }, 3),
  ).toEqual({ left: 228, top: 754 });

  expect(
    menuAboveAnchor({ x: 10, y: 50, width: 36, height: 44 }, { width: 300, height: 200 }, 3),
  ).toEqual({ left: 8, top: 8 });
});
