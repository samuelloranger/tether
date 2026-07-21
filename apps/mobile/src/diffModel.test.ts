import { expect, test } from 'bun:test';
import {
  annotateHunkIndices,
  groupSummary,
  pairDiffRows,
  buildFileTree,
  changeLabel,
  diffLineKinds,
  displayDiff,
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

test('buildFileTree nests folders like a real file tree, not a flat path-prefix group', () => {
  const files = [
    { path: 'src/a.ts', insertions: 1, deletions: 0, binary: false },
    { path: 'README.md', insertions: 1, deletions: 0, binary: false },
    { path: 'src/b.ts', insertions: 0, deletions: 1, binary: false },
    { path: 'src/nested/c.ts', insertions: 2, deletions: 0, binary: false },
  ];
  expect(buildFileTree(files)).toEqual([
    {
      type: 'dir',
      name: 'src',
      path: 'src',
      children: [
        { type: 'file', name: 'a.ts', path: 'src/a.ts', file: files[0] },
        { type: 'file', name: 'b.ts', path: 'src/b.ts', file: files[2] },
        {
          type: 'dir',
          name: 'nested',
          path: 'src/nested',
          children: [{ type: 'file', name: 'c.ts', path: 'src/nested/c.ts', file: files[3] }],
        },
      ],
    },
    { type: 'file', name: 'README.md', path: 'README.md', file: files[1] },
  ]);
});

test('buildFileTree reuses the same folder node across sibling files instead of duplicating it', () => {
  const files = [
    { path: 'src/a.ts', insertions: 1, deletions: 0, binary: false },
    { path: 'src/nested/c.ts', insertions: 2, deletions: 0, binary: false },
    { path: 'src/b.ts', insertions: 0, deletions: 1, binary: false },
  ];
  const tree = buildFileTree(files);
  expect(tree).toHaveLength(1);
  expect(tree[0].type).toBe('dir');
  if (tree[0].type === 'dir') expect(tree[0].children).toHaveLength(3);
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
    {
      text: 'diff --git a/main.ts b/main.ts',
      kind: 'meta',
      content: 'diff --git a/main.ts b/main.ts',
      oldLine: null,
      newLine: null,
    },
    {
      text: '@@ -1,3 +1,3 @@',
      kind: 'meta',
      content: '@@ -1,3 +1,3 @@',
      oldLine: null,
      newLine: null,
    },
    { text: ' unchanged', kind: 'context', content: 'unchanged', oldLine: 1, newLine: 1 },
    { text: '-old line', kind: 'remove', content: 'old line', oldLine: 2, newLine: null },
    { text: '+new line', kind: 'add', content: 'new line', oldLine: null, newLine: 2 },
    { text: ' trailing', kind: 'context', content: 'trailing', oldLine: 3, newLine: 3 },
  ]);
});

test('groupSummary splits staged and unstaged entries', () => {
  const summary = {
    files: [
      { path: 'a.txt', insertions: 1, deletions: 0, binary: false, staged: true },
      { path: 'a.txt', insertions: 2, deletions: 0, binary: false, staged: false },
      { path: 'b.txt', insertions: 3, deletions: 1, binary: false, staged: false },
      // Legacy payload without the flag counts as unstaged.
      { path: 'c.txt', insertions: 1, deletions: 1, binary: false },
    ],
  };
  const groups = groupSummary(summary);
  expect(groups.staged.map((f) => f.path)).toEqual(['a.txt']);
  expect(groups.unstaged.map((f) => f.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
});

test('annotateHunkIndices numbers hunk header lines in order', () => {
  const diff = [
    'diff --git a/x b/x',
    '@@ -1,2 +1,2 @@',
    '-a',
    '+b',
    '@@ -10,2 +10,2 @@',
    '-c',
    '+d',
  ].join('\n');
  const indices = annotateHunkIndices(parseDiffLines(diff));
  expect(indices).toEqual([null, 0, null, null, 1, null, null]);
});

test('pairDiffRows aligns removes with adds side by side', () => {
  const diff = [
    '@@ -1,4 +1,4 @@',
    ' keep',
    '-old1',
    '-old2',
    '+new1',
    ' tail',
  ].join('\n');
  const rows = pairDiffRows(parseDiffLines(diff));
  // meta row spans both sides
  expect(rows[0]).toEqual({ left: expect.objectContaining({ kind: 'meta' }), right: null, span: true });
  expect(rows[1]).toEqual({
    left: expect.objectContaining({ content: 'keep' }),
    right: expect.objectContaining({ content: 'keep' }),
    span: false,
  });
  // old1 pairs with new1; old2 has an empty right side
  expect(rows[2].left?.content).toBe('old1');
  expect(rows[2].right?.content).toBe('new1');
  expect(rows[3].left?.content).toBe('old2');
  expect(rows[3].right).toBeNull();
  expect(rows[4].left?.content).toBe('tail');
  expect(rows[4].right?.content).toBe('tail');
});
