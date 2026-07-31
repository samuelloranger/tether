import { expect, test } from 'bun:test';
import { parseSidebarPinned, parseSnippets } from './useAppPreferences';

test('parseSnippets keeps only stored string snippets', () => {
  expect(parseSnippets('["git status", 12, null, "npm test"]')).toEqual(['git status', 'npm test']);
});

test('parseSnippets falls back safely for malformed storage', () => {
  expect(parseSnippets('{not json')).toEqual([]);
  expect(parseSnippets('{"snippet":"git status"}')).toEqual([]);
});

test('parseSidebarPinned accepts only the string true', () => {
  expect(parseSidebarPinned('true')).toBe(true);
  expect(parseSidebarPinned('false')).toBe(false);
  expect(parseSidebarPinned(null)).toBe(false);
  expect(parseSidebarPinned('1')).toBe(false);
  expect(parseSidebarPinned('yes')).toBe(false);
  expect(parseSidebarPinned('')).toBe(false);
});
