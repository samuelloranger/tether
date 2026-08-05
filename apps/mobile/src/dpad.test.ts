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

test('D-pad thumb slides only on the active cardinal axis', () => {
  // Neutral / under threshold — stay centered (no free slide).
  expect(thumbOffset(5, -3, null)).toEqual({ x: 0, y: 0 });
  // Diagonal finger → icon rides the locked axis only, never free 2D.
  expect(thumbOffset(100, -100, 'C')).toEqual({ x: 11, y: 0 });
  expect(thumbOffset(100, -100, 'A')).toEqual({ x: 0, y: -11 });
  expect(thumbOffset(-40, 20, 'D')).toEqual({ x: -11, y: 0 });
  expect(thumbOffset(10, 40, 'B')).toEqual({ x: 0, y: 11 });
  // Opposite-axis / reverse-axis drift while locked stays on that cardinal
  // (glyph must not collapse to center while auto-repeat still fires).
  expect(thumbOffset(-20, 0, 'C')).toEqual({ x: 11, y: 0 });
  expect(thumbOffset(0, 20, 'A')).toEqual({ x: 0, y: -11 });
  expect(thumbOffset(-10, 20, 'C')).toEqual({ x: 11, y: 0 });
});
