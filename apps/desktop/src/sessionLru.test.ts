import { describe, expect, test } from 'bun:test';
import { touchLru } from './sessionLru';

describe('touchLru', () => {
  test('moves a touched key to the front', () => {
    expect(touchLru(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  test('de-duplicates — a re-touched key is not repeated', () => {
    expect(touchLru(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });

  test('adds a new key at the front', () => {
    expect(touchLru(['a'], 'b')).toEqual(['b', 'a']);
  });

  test('truncates to max, dropping the least-recent', () => {
    expect(touchLru(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });

  test('does not mutate the input', () => {
    const input = ['a', 'b'];
    touchLru(input, 'c');
    expect(input).toEqual(['a', 'b']);
  });
});
