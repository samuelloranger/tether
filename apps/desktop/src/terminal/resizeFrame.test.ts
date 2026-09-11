import { describe, expect, test } from 'bun:test';
import { focusReportBytes, resizeFrame, socketOpenFrames } from './resizeFrame';

describe('resizeFrame', () => {
  test('passes through dims', () => {
    expect(resizeFrame({ cols: 120, rows: 40 })).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });
  test('defaults undefined dims to 80x24', () => {
    expect(resizeFrame(undefined)).toEqual({ type: 'resize', cols: 80, rows: 24 });
  });
});

describe('socketOpenFrames', () => {
  test('sends the fitted size then focus so a TUI gets SIGWINCH after connect', () => {
    expect(socketOpenFrames({ cols: 132, rows: 43 }, true)).toEqual([
      { type: 'resize', cols: 132, rows: 43 },
      { type: 'focus', focused: true },
    ]);
  });
});

describe('focusReportBytes', () => {
  test('DECSET 1004 focus in/out', () => {
    expect(focusReportBytes(true)).toBe('\x1b[I');
    expect(focusReportBytes(false)).toBe('\x1b[O');
  });
});
