import { describe, expect, it } from 'bun:test';
import { cellFromPoint, clickSeqs, motionSeq, pressSeq, releaseSeq } from './mouseInput';

const rect = { left: 0, top: 0, width: 800, height: 480 }; // 80 cols × 24 rows → 10px cell

describe('cellFromPoint', () => {
  it('maps a point to a 1-based clamped cell', () => {
    expect(cellFromPoint(0, 0, rect, 80, 24)).toEqual({ col: 1, row: 1 });
    expect(cellFromPoint(15, 45, rect, 80, 24)).toEqual({ col: 2, row: 3 });
    expect(cellFromPoint(10000, 10000, rect, 80, 24)).toEqual({ col: 80, row: 24 });
    expect(cellFromPoint(-50, -50, rect, 80, 24)).toEqual({ col: 1, row: 1 });
  });
});

describe('clickSeqs', () => {
  it('press+release in normal mode (SGR)', () => {
    expect(clickSeqs(5, 3, 'normal', true)).toEqual(['\x1b[<0;5;3M', '\x1b[<0;5;3m']);
  });
  it('press only in x10 mode', () => {
    expect(clickSeqs(5, 3, 'x10', true)).toEqual(['\x1b[<0;5;3M']);
  });
});

describe('drag builders', () => {
  it('motionSeq null unless button/any', () => {
    expect(motionSeq(5, 3, 'normal', true)).toBeNull();
    expect(motionSeq(5, 3, 'x10', true)).toBeNull();
    expect(motionSeq(5, 3, 'button', true)).toBe('\x1b[<32;5;3M');
    expect(motionSeq(5, 3, 'any', true)).toBe('\x1b[<32;5;3M');
  });
  it('releaseSeq null in x10, else final m', () => {
    expect(releaseSeq(5, 3, 'x10', true)).toBeNull();
    expect(releaseSeq(5, 3, 'button', true)).toBe('\x1b[<0;5;3m');
  });
  it('pressSeq encodes a plain press', () => {
    expect(pressSeq(5, 3, true)).toBe('\x1b[<0;5;3M');
  });
});
