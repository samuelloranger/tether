import { describe, expect, test } from 'bun:test';
import { wordAtColumn } from './wordAt';

describe('wordAtColumn', () => {
  test('picks the word under the column', () => {
    expect(wordAtColumn('git push origin main', 5)).toBe('push');
    expect(wordAtColumn('git push origin main', 0)).toBe('git');
    expect(wordAtColumn('git push origin main', 19)).toBe('main');
  });

  test('shell-flavored words: paths, flags, urls', () => {
    expect(wordAtColumn('cat ~/sites/tether/README.md here', 10)).toBe('~/sites/tether/README.md');
    expect(wordAtColumn('run --with-flag=value ok', 8)).toBe('--with-flag=value');
    expect(wordAtColumn('see https://example.com/x now', 8)).toBe('https://example.com/x');
  });

  test('null on whitespace or out of range', () => {
    expect(wordAtColumn('a b', 1)).toBeNull();
    expect(wordAtColumn('abc', -1)).toBeNull();
    expect(wordAtColumn('abc', 50)).toBeNull();
    expect(wordAtColumn('', 0)).toBeNull();
  });
});
