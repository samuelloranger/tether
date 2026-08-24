import { describe, expect, test } from 'bun:test';
import { replayOutputFrames, selectReplayNewest } from './replayPlan';

// Newest-first byte metadata, the shape getLogSizesNewest yields from SQL.
const sizes = (...bytes: number[]) =>
  bytes.map((size, i) => ({ id: i + 1, bytes: size })).reverse();

describe('selectReplayNewest', () => {
  test('selects an id range from byte metadata without reading older rows', () => {
    let consumed = 0;
    function* newestFirst() {
      for (const row of [
        { id: 4, bytes: 50 },
        { id: 3, bytes: 50 },
        { id: 2, bytes: 50 },
        { id: 1, bytes: 50 },
      ]) {
        consumed++;
        yield row;
      }
    }

    expect(selectReplayNewest(newestFirst(), 100)).toEqual({
      reset: true,
      oldestId: 3,
      newestId: 4,
      count: 2,
      bytes: 100,
    });
    expect(consumed).toBe(3);
  });

  test('passes everything through when under budget', () => {
    expect(selectReplayNewest(sizes(10, 10, 10), 100)).toEqual({
      reset: false,
      oldestId: 1,
      newestId: 3,
      count: 3,
      bytes: 30,
    });
  });

  test('handles an empty replay', () => {
    expect(selectReplayNewest([], 100)).toEqual({
      reset: false,
      oldestId: null,
      newestId: null,
      count: 0,
      bytes: 0,
    });
  });

  test('drops an oversized old row rather than blowing the budget', () => {
    expect(selectReplayNewest(sizes(1_000_000, 10, 10), 100)).toEqual({
      reset: true,
      oldestId: 2,
      newestId: 3,
      count: 2,
      bytes: 20,
    });
  });

  test('always keeps the newest row even when it alone exceeds the budget', () => {
    expect(selectReplayNewest(sizes(10, 500), 100)).toEqual({
      reset: true,
      oldestId: 2,
      newestId: 2,
      count: 1,
      bytes: 500,
    });
  });

  test('a single oversized row is still replayed without a reset', () => {
    expect(selectReplayNewest(sizes(500), 100)).toEqual({
      reset: false,
      oldestId: 1,
      newestId: 1,
      count: 1,
      bytes: 500,
    });
  });
});

describe('replayOutputFrames', () => {
  test('coalesces contiguous rows and advances each frame to its final log id', () => {
    const logs = ['a', 'b', 'c', 'd', 'e'].map((chunk, index) => ({ id: index + 1, chunk }));
    expect(replayOutputFrames(logs, 2)).toEqual([
      { type: 'output', id: 2, chunk: 'ab' },
      { type: 'output', id: 4, chunk: 'cd' },
      { type: 'output', id: 5, chunk: 'e' },
    ]);
  });
});
