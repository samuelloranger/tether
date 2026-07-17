import { expect, test } from 'bun:test';
import { lineOffset } from './fileView';

test('lineOffset clamps one-based source locations', () => {
  const content = 'one\ntwo\nthree\n';
  expect(lineOffset(content, 1)).toBe(0);
  expect(lineOffset(content, 3)).toBe(2);
  expect(lineOffset(content, 99)).toBe(3);
  expect(lineOffset(content, undefined)).toBe(0);
});

test('lineOffset maps a requested source row without changing the original text', () => {
  const content = 'const first = 1;\nconst second = 2;';
  expect(lineOffset(content, 2)).toBe(1);
  expect(content).toBe('const first = 1;\nconst second = 2;');
});
