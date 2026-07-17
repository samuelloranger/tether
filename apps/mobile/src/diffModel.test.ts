import { expect, test } from 'bun:test';
import { totalChanges } from './diffModel';

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
