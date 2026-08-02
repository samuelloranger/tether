import { describe, expect, test } from 'bun:test';
import { planReplay } from './replayPlan';

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
});
