import { expect, test } from 'bun:test';
import type { DiffSummary } from './diffModel';
import {
  canCommit,
  mapWithConcurrency,
  reviewDiffKey,
  reviewFileEntries,
  toggleSetMember,
} from './gitReviewModel';

test('reviewFileEntries lists staged then unstaged preserving summary order within each group', () => {
  const summary: DiffSummary = {
    files: [
      { path: 'b.ts', insertions: 1, deletions: 0, binary: false, staged: false },
      { path: 'a.ts', insertions: 1, deletions: 0, binary: false, staged: true },
      { path: 'c.ts', insertions: 0, deletions: 1, binary: false, staged: true },
    ],
  };
  expect(reviewFileEntries(summary).map((e) => `${e.mode}:${e.path}`)).toEqual([
    'staged:a.ts',
    'staged:c.ts',
    'unstaged:b.ts',
  ]);
});

test('reviewDiffKey distinguishes the same path on both sides of the index', () => {
  expect(reviewDiffKey('staged', 'x.ts')).toBe('staged:x.ts');
  expect(reviewDiffKey('unstaged', 'x.ts')).toBe('unstaged:x.ts');
});

test('toggleSetMember adds then removes', () => {
  const once = toggleSetMember(new Set(), 'a');
  expect(once.has('a')).toBe(true);
  expect(toggleSetMember(once, 'a').has('a')).toBe(false);
});

test('canCommit requires staged files, non-empty message, and idle commit', () => {
  expect(canCommit(1, 'msg', false)).toBe(true);
  expect(canCommit(0, 'msg', false)).toBe(false);
  expect(canCommit(1, '  ', false)).toBe(false);
  expect(canCommit(1, 'msg', true)).toBe(false);
});

test('mapWithConcurrency respects the limit and preserves order', async () => {
  let inflight = 0;
  let max = 0;
  const items = [1, 2, 3, 4, 5];
  const out = await mapWithConcurrency(items, 2, async (n) => {
    inflight++;
    max = Math.max(max, inflight);
    await Bun.sleep(5);
    inflight--;
    return n * 10;
  });
  expect(out).toEqual([10, 20, 30, 40, 50]);
  expect(max).toBeLessThanOrEqual(2);
});
