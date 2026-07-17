import { expect, test } from 'bun:test';
import { changeLabel, displayDiff, totalChanges } from './diffModel';

test('changeLabel formats nonempty totals and hides an empty summary', () => {
  expect(changeLabel({ files: [{ path: 'a.ts', insertions: 3, deletions: 2 }] })).toBe('+3 -2');
  expect(changeLabel({ files: [] })).toBeNull();
});

test('totalChanges sums insertions and deletions across files', () => {
  expect(totalChanges({ files: [] })).toBe(0);
  expect(
    totalChanges({
      files: [
        { path: 'a.ts', insertions: 3, deletions: 1 },
        { path: 'b.ts', insertions: 0, deletions: 2 },
      ],
    }),
  ).toBe(6);
});

test('displayDiff warns when the server truncates a diff', () => {
  expect(displayDiff('line 1\n', true)).toBe('line 1\n\n[Diff truncated at 1 MiB]');
});
