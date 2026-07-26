import {
  D_PAD_BUTTON_SIZE,
  D_PAD_DIRECTIONS,
  resolveDPadDirection,
  thumbOffset,
} from './dpadModel';
import { MIN_TOUCH_TARGET } from './interaction';

test('D-pad gives every direction a full touch target and binds Down to B', () => {
  expect(D_PAD_BUTTON_SIZE).toBe(MIN_TOUCH_TARGET);
  expect(D_PAD_DIRECTIONS).toEqual([
    { label: 'left', final: 'D' },
    { label: 'up', final: 'A' },
    { label: 'down', final: 'B' },
    { label: 'right', final: 'C' },
  ]);
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
