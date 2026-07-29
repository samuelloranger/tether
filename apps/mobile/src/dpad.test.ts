import {
  D_PAD_BUTTON_SIZE,
  D_PAD_MAX_REPEATS,
  grantOffset,
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

test('D-pad locks its active direction for the whole gesture', () => {
  expect(resolveDPadDirection(15, 16, 'C')).toBe('C');
  expect(resolveDPadDirection(10, 20, 'C')).toBe('C');
  expect(resolveDPadDirection(2, 2, 'C')).toBeNull();
});

test('D-pad tap on a chevron resolves to that direction', () => {
  const center = D_PAD_BUTTON_SIZE / 2;
  // Left chevron sits ~16pt left of center — a plain tap there must send Left.
  const left = grantOffset(center - 16, center);
  expect(resolveDPadDirection(left.x, left.y, null)).toBe('D');
  const up = grantOffset(center, center - 16);
  expect(resolveDPadDirection(up.x, up.y, null)).toBe('A');
  // A dead-center tap is still neutral.
  const middle = grantOffset(center, center);
  expect(resolveDPadDirection(middle.x, middle.y, null)).toBeNull();
});

test('D-pad auto-repeat is capped', () => {
  expect(D_PAD_MAX_REPEATS).toBeGreaterThan(0);
  expect(D_PAD_MAX_REPEATS).toBeLessThanOrEqual(200);
});

test('D-pad thumb stays bounded inside its control', () => {
  expect(thumbOffset(100, -100)).toEqual({ x: 8, y: -8 });
});
