import { expect, test } from 'bun:test';
import { changeBannerLabel } from './diffModel';

test('change banner exposes accessible copy only for nonempty summaries', () => {
  expect(
    changeBannerLabel({ files: [{ path: 'a.ts', insertions: 3, deletions: 2, binary: false }] }),
  ).toBe('View changes, +3 -2');
  expect(changeBannerLabel({ files: [] })).toBeNull();
});
