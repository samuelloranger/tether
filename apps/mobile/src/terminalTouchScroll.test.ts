import { expect, test } from 'bun:test';
import { touchScrollLines } from './terminalTouchScroll';

test('touch scrolling converts finger movement into whole terminal rows without losing pixels', () => {
  expect(touchScrollLines(30, 0, 13)).toEqual({ lines: 2, remainder: 4 });
  expect(touchScrollLines(-30, 0, 13)).toEqual({ lines: -2, remainder: -4 });
  expect(touchScrollLines(8, 4, 13)).toEqual({ lines: 0, remainder: 12 });
});
