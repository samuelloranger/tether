import {
  D_PAD_BUTTON_SIZE,
  resolveDPadDirection,
  thumbOffset,
} from './dpadModel';
import { MIN_TOUCH_TARGET } from './interaction';

test('D-pad is a full touch target', () => {
  expect(D_PAD_BUTTON_SIZE).toBe(MIN_TOUCH_TARGET);
});

test('D-pad remains neutral inside the center threshold', () => {
  expect(resolveDPadDirection(5, -3, null)).toBeNull();
  expect(resolveDPadDirection(0, 0, 'B')).toBeNull();
});

test('D-pad maps cardinals and diagonals to terminal finals', () => {
  expect(resolveDPadDirection(16, 0, null)).toBe('C');
  expect(resolveDPadDirection(-16, 0, null)).toBe('D');
  expect(resolveDPadDirection(0, -16, null)).toBe('A');
  expect(resolveDPadDirection(0, 16, null)).toBe('B');
  expect(resolveDPadDirection(20, 12, null)).toBe('C');
  expect(resolveDPadDirection(-12, 20, null)).toBe('B');
});

test('D-pad keeps its active direction near an axis boundary', () => {
  expect(resolveDPadDirection(15, 16, 'C')).toBe('C');
  expect(resolveDPadDirection(10, 20, 'C')).toBe('B');
});

test('D-pad thumb stays bounded inside its control', () => {
  expect(thumbOffset(100, -100)).toEqual({ x: 8, y: -8 });
});
