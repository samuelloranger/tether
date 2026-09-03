import { describe, expect, test } from 'bun:test';
import { resizeFrame } from './resizeFrame';

describe('resizeFrame', () => {
  test('passes through dims', () => {
    expect(resizeFrame({ cols: 120, rows: 40 })).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });
  test('defaults undefined dims to 80x24', () => {
    expect(resizeFrame(undefined)).toEqual({ type: 'resize', cols: 80, rows: 24 });
  });
});
