import { describe, expect, it } from 'bun:test';
import { activityDotKey, activityLabel } from './activity';

describe('activityDotKey', () => {
  it('carries the server classification straight through', () => {
    expect(activityDotKey('running', 'working', false)).toBe('working');
    expect(activityDotKey('running', 'waiting', false)).toBe('waiting');
    expect(activityDotKey('running', 'idle', false)).toBe('idle');
  });

  it('gives a finished session its own dot, not idle', () => {
    expect(activityDotKey('running', 'done', false)).toBe('done');
  });

  it('is stopped whatever the server last said', () => {
    expect(activityDotKey('stopped', 'done', true)).toBe('stopped');
    expect(activityDotKey('stopped', 'working', true)).toBe('stopped');
  });

  it('falls back to recency when the server has no classification', () => {
    expect(activityDotKey('running', null, true)).toBe('working');
    expect(activityDotKey('running', null, false)).toBe('idle');
  });
});

describe('activityLabel', () => {
  it('reads as finished, not as needing you', () => {
    expect(activityLabel('done')).toBe('finished');
    expect(activityLabel('waiting')).toBe('needs input');
  });
});
