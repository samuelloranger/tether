import { expect, test } from 'bun:test';
import { canCommit, groupSummary } from './gitApi';
import { reviewDiffKey, reviewFileEntries } from './gitReviewHelpers';
import { submitGitMessage } from './useGitCommitForm';

test('groupSummary splits staged unstaged and untracked', () => {
  const groups = groupSummary({
    files: [
      { path: 'a.ts', insertions: 1, deletions: 0, binary: false, staged: true },
      { path: 'b.ts', insertions: 1, deletions: 0, binary: false, staged: false },
      { path: 'c.ts', insertions: 1, deletions: 0, binary: false, untracked: true },
    ],
  });
  expect(groups.staged.map((f) => f.path)).toEqual(['a.ts']);
  expect(groups.unstaged.map((f) => f.path)).toEqual(['b.ts']);
  expect(groups.untracked.map((f) => f.path)).toEqual(['c.ts']);
});

test('reviewFileEntries lists staged then unstaged', () => {
  const entries = reviewFileEntries({
    files: [
      { path: 'b.ts', insertions: 1, deletions: 0, binary: false, staged: false },
      { path: 'a.ts', insertions: 1, deletions: 0, binary: false, staged: true },
    ],
  });
  expect(entries.map((e) => reviewDiffKey(e.mode, e.path))).toEqual([
    'staged:a.ts',
    'unstaged:b.ts',
  ]);
});

test('canCommit and submitGitMessage gate empty commits', async () => {
  expect(canCommit(1, 'msg', false)).toBe(true);
  expect(canCommit(0, 'msg', false)).toBe(false);
  expect(await submitGitMessage('  ', false, async () => true)).toBe(false);
  expect(await submitGitMessage('ok', false, async () => true)).toBe(true);
});
