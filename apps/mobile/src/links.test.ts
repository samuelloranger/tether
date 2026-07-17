import { expect, test } from 'bun:test';
import { computeLinkSpans, parseFileTarget } from './links';

test('parses workspace files and source locations', () => {
  expect(parseFileTarget('docs/superpowers/specs/design.md')).toEqual({
    kind: 'file',
    path: 'docs/superpowers/specs/design.md',
  });
  expect(parseFileTarget('apps/mobile/src/App.tsx:42:9')).toEqual({
    kind: 'file',
    path: 'apps/mobile/src/App.tsx',
    line: 42,
    column: 9,
  });
  expect(parseFileTarget('/etc/passwd')).toBeNull();
  expect(parseFileTarget('../secret.txt')).toBeNull();
  expect(parseFileTarget('plain-word')).toBeNull();
});

test('soft-wrapped file links carry the whole typed target', () => {
  const path = 'docs/superpowers/specs/2026-07-16-terminal-file-viewer-design.md';
  const spans = computeLinkSpans([path.slice(0, 24), path.slice(24)], [true, false]);
  expect(spans[0][0].target).toEqual({ kind: 'file', path });
  expect(spans[1][0].target).toEqual({ kind: 'file', path });
});
