import { expect, test } from 'bun:test';
import { parseSnippets } from './useAppPreferences';

test('parseSnippets keeps only stored string snippets', () => {
  expect(parseSnippets('["git status", 12, null, "npm test"]')).toEqual(['git status', 'npm test']);
});

test('parseSnippets falls back safely for malformed storage', () => {
  expect(parseSnippets('{not json')).toEqual([]);
  expect(parseSnippets('{"snippet":"git status"}')).toEqual([]);
});
