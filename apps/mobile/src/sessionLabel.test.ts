import { expect, test } from 'bun:test';
import { sessionLabel } from './sessionLabel';

test('manual name wins over auto title', () => {
  expect(sessionLabel({ id: 'abc', name: 'prod box', auto_title: 'vim' })).toBe('prod box');
});

test('auto title used when no manual name', () => {
  expect(sessionLabel({ id: 'abc', name: null, auto_title: 'tether' })).toBe('tether');
});

test('falls back to id when neither set', () => {
  expect(sessionLabel({ id: 'abc' })).toBe('abc');
  expect(sessionLabel({ id: 'abc', name: '', auto_title: null })).toBe('abc');
});
