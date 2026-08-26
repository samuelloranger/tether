import { expect, test } from 'bun:test';
import { canCommit, groupSummary } from './gitApi';
import { changesPaneContent, loadPaneContent } from './gitPanelState';
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

test('rejected load is error state, not empty', () => {
  expect(changesPaneContent('not a git repository', 0)).toEqual({
    type: 'error',
    message: 'not a git repository',
  });
  expect(loadPaneContent('not a git repository', false)).toEqual({
    type: 'error',
    message: 'not a git repository',
  });
});

test('successful empty load stays empty', () => {
  expect(changesPaneContent(null, 0)).toEqual({ type: 'empty' });
  expect(loadPaneContent(null, false)).toEqual({ type: 'empty' });
});

test('files present keep the list even when an op error is set', () => {
  expect(changesPaneContent('push failed', 2)).toEqual({ type: 'files' });
  expect(loadPaneContent('push failed', true)).toEqual({ type: 'ready' });
});
