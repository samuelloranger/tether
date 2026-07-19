import { expect, test } from 'bun:test';
import {
  changeLabel,
  diffLineKinds,
  displayDiff,
  groupFilesByDirectory,
  isImagePath,
  parseDiffLines,
  totalChanges,
} from './diffModel';

test('changeLabel formats nonempty totals and hides an empty summary', () => {
  expect(
    changeLabel({ files: [{ path: 'a.ts', insertions: 3, deletions: 2, binary: false }] }),
  ).toBe('+3 -2');
  expect(
    changeLabel({ files: [{ path: 'binary.png', insertions: 0, deletions: 0, binary: true }] }),
  ).toBe('+0 -0');
  expect(changeLabel({ files: [] })).toBeNull();
});

test('totalChanges sums insertions and deletions across files', () => {
  expect(totalChanges({ files: [] })).toBe(0);
  expect(
    totalChanges({
      files: [
        { path: 'a.ts', insertions: 3, deletions: 1, binary: false },
        { path: 'b.ts', insertions: 0, deletions: 2, binary: false },
      ],
    }),
  ).toBe(6);
});

test('displayDiff warns when the server truncates a diff', () => {
  expect(displayDiff('line 1\n', true)).toBe('line 1\n\n[Diff truncated at 1 MiB]');
});

test('diffLineKinds preserves prefixes while classifying unified diff rows', () => {
  const diff = '+const answer = 43;\n-old\n@@ -1 +1 @@';
  expect(diffLineKinds(diff)).toEqual(['add', 'remove', 'meta']);
  expect(diff.split('\n').slice(0, 2)).toEqual(['+const answer = 43;', '-old']);
});

test('isImagePath recognizes common image extensions case-insensitively', () => {
  expect(isImagePath('logo.PNG')).toBe(true);
  expect(isImagePath('assets/icon.svg')).toBe(true);
  expect(isImagePath('main.ts')).toBe(false);
});

test('groupFilesByDirectory groups files under their parent directory, root files under ""', () => {
  const files = [
    { path: 'src/a.ts', insertions: 1, deletions: 0, binary: false },
    { path: 'README.md', insertions: 1, deletions: 0, binary: false },
    { path: 'src/b.ts', insertions: 0, deletions: 1, binary: false },
    { path: 'src/nested/c.ts', insertions: 2, deletions: 0, binary: false },
  ];
  expect(groupFilesByDirectory(files)).toEqual([
    { dir: 'src', files: [files[0], files[2]] },
    { dir: '', files: [files[1]] },
    { dir: 'src/nested', files: [files[3]] },
  ]);
});

test('parseDiffLines assigns old/new line numbers per hunk and strips diff markers from content', () => {
  const diff = [
    'diff --git a/main.ts b/main.ts',
    '@@ -1,3 +1,3 @@',
    ' unchanged',
    '-old line',
    '+new line',
    ' trailing',
  ].join('\n');
  expect(parseDiffLines(diff)).toEqual([
    { text: 'diff --git a/main.ts b/main.ts', kind: 'meta', content: 'diff --git a/main.ts b/main.ts', oldLine: null, newLine: null },
    { text: '@@ -1,3 +1,3 @@', kind: 'meta', content: '@@ -1,3 +1,3 @@', oldLine: null, newLine: null },
    { text: ' unchanged', kind: 'context', content: 'unchanged', oldLine: 1, newLine: 1 },
    { text: '-old line', kind: 'remove', content: 'old line', oldLine: 2, newLine: null },
    { text: '+new line', kind: 'add', content: 'new line', oldLine: null, newLine: 2 },
    { text: ' trailing', kind: 'context', content: 'trailing', oldLine: 3, newLine: 3 },
  ]);
});
