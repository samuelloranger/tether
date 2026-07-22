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

test('trailing punctuation is not part of a url', () => {
  const paren = computeLinkSpans(['(https://selfh.st/weekly/2026-07-17/) more'], [false]);
  expect(paren[0][0].target).toEqual({
    kind: 'external',
    url: 'https://selfh.st/weekly/2026-07-17/',
  });
  const period = computeLinkSpans(['see https://example.com/a.'], [false]);
  expect(period[0][0].target).toEqual({ kind: 'external', url: 'https://example.com/a' });
});

test('balanced parens inside a url are kept', () => {
  const spans = computeLinkSpans(['https://en.wikipedia.org/wiki/Foo_(bar) x'], [false]);
  expect(spans[0][0].target).toEqual({
    kind: 'external',
    url: 'https://en.wikipedia.org/wiki/Foo_(bar)',
  });
});

test('soft-wrapped paren-url carries the whole trimmed url', () => {
  const url = 'https://github.com/samuelloranger/labby';
  const line = `(${url})`;
  const spans = computeLinkSpans([line.slice(0, 24), line.slice(24)], [true, false]);
  expect(spans[0][0].target).toEqual({ kind: 'external', url });
  expect(spans[1][0].target).toEqual({ kind: 'external', url });
});

test('soft-wrapped file links carry the whole typed target', () => {
  const path = 'docs/superpowers/specs/2026-07-16-terminal-file-viewer-design.md';
  const spans = computeLinkSpans([path.slice(0, 24), path.slice(24)], [true, false]);
  expect(spans[0][0].target).toEqual({ kind: 'file', path });
  expect(spans[1][0].target).toEqual({ kind: 'file', path });
});
