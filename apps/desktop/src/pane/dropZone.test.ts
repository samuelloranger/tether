import { describe, expect, test } from 'bun:test';
import { dropIntent } from './dropZone';

const rect = { left: 0, top: 0, width: 300, height: 200 };

describe('dropIntent', () => {
  test('center is replace', () => {
    expect(dropIntent(150, 100, rect)).toEqual({ kind: 'replace' });
  });
  test('left edge splits row/a', () => {
    expect(dropIntent(10, 100, rect)).toEqual({ kind: 'split', dir: 'row', side: 'a' });
  });
  test('right edge splits row/b', () => {
    expect(dropIntent(290, 100, rect)).toEqual({ kind: 'split', dir: 'row', side: 'b' });
  });
  test('top edge splits col/a', () => {
    expect(dropIntent(150, 8, rect)).toEqual({ kind: 'split', dir: 'col', side: 'a' });
  });
  test('bottom edge splits col/b', () => {
    expect(dropIntent(150, 192, rect)).toEqual({ kind: 'split', dir: 'col', side: 'b' });
  });
  test('a corner resolves to the nearer normalized edge', () => {
    expect(dropIntent(20, 4, rect)).toEqual({ kind: 'split', dir: 'col', side: 'a' });
  });
});
