import { describe, expect, test } from 'bun:test';
import { rowsThatFit } from './fitTerminal';

describe('rowsThatFit', () => {
  test('clamps down when FitAddon over-counted for the painted cell', () => {
    // The reproduced desktop bug: 60 rows proposed, painted cell 16px, only
    // 926px of viewport → 60*16=960 overflows. floor(926/16)=57.
    expect(rowsThatFit(926, 16, 60)).toBe(57);
  });

  test('leaves the row count alone when it already fits', () => {
    expect(rowsThatFit(960, 16, 60)).toBe(60);
    expect(rowsThatFit(1000, 16, 60)).toBe(60);
  });

  test('never returns fewer than one row', () => {
    expect(rowsThatFit(8, 16, 3)).toBe(1);
  });

  test('is a no-op for degenerate metrics', () => {
    expect(rowsThatFit(0, 16, 24)).toBe(24);
    expect(rowsThatFit(500, 0, 24)).toBe(24);
    expect(rowsThatFit(500, 16, 0)).toBe(0);
  });
});
