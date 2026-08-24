import { describe, expect, test } from 'bun:test';
import { planReplay, planReplayNewest, replayOutputFrames } from './replayPlan';

const rows = (...sizes: number[]) =>
  sizes.map((size, i) => ({ id: i + 1, chunk: 'x'.repeat(size) }));

describe('planReplay', () => {
  test('passes everything through when under budget', () => {
    const logs = rows(10, 10, 10);
    const plan = planReplay(logs, 100);
    expect(plan.reset).toBe(false);
    expect(plan.logs).toEqual(logs);
    expect(plan.bytes).toBe(30);
  });

  test('handles an empty replay', () => {
    expect(planReplay([], 100)).toEqual({ reset: false, logs: [], bytes: 0 });
  });

  test('keeps the newest suffix and asks for a reset when over budget', () => {
    const logs = rows(50, 50, 50, 50);
    const plan = planReplay(logs, 100);
    expect(plan.reset).toBe(true);
    expect(plan.logs.map((row) => row.id)).toEqual([3, 4]);
    expect(plan.bytes).toBe(100);
  });

  test('drops an oversized old row rather than blowing the budget', () => {
    const logs = rows(1_000_000, 10, 10);
    const plan = planReplay(logs, 100);
    expect(plan.reset).toBe(true);
    expect(plan.logs.map((row) => row.id)).toEqual([2, 3]);
    expect(plan.bytes).toBe(20);
  });

  test('always keeps the newest row even when it alone exceeds the budget', () => {
    const logs = rows(10, 500);
    const plan = planReplay(logs, 100);
    expect(plan.reset).toBe(true);
    expect(plan.logs.map((row) => row.id)).toEqual([2]);
    expect(plan.bytes).toBe(500);
  });

  test('a single oversized row is still replayed', () => {
    const plan = planReplay(rows(500), 100);
    expect(plan.reset).toBe(false);
    expect(plan.logs.map((row) => row.id)).toEqual([1]);
  });

  test('counts UTF-8 bytes for multibyte terminal output', () => {
    const logs = [
      { id: 1, chunk: '🚀'.repeat(2) },
      { id: 2, chunk: '中' },
    ];
    const plan = planReplay(logs, 10);
    expect(plan.reset).toBe(true);
    expect(plan.logs.map((row) => row.id)).toEqual([2]);
    expect(plan.bytes).toBe(3);
  });
});

describe('planReplayNewest', () => {
  test('stops consuming rows once the newest suffix fills the budget', () => {
    let consumed = 0;
    function* newestFirst() {
      for (const log of [...rows(50, 50, 50, 50)].reverse()) {
        consumed++;
        yield log;
      }
    }

    const plan = planReplayNewest(newestFirst(), 100);
    expect(plan.reset).toBe(true);
    expect(plan.logs.map((row) => row.id)).toEqual([3, 4]);
    expect(plan.bytes).toBe(100);
    expect(consumed).toBe(3);
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
