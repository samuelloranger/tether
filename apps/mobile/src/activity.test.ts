import { describe, expect, test } from 'bun:test';
import { type ActivityRow, activityDotKey, activityLabel, newlyWaiting } from './activity';

describe('activityDotKey', () => {
  test('stopped wins regardless of activity', () => {
    expect(activityDotKey('stopped', 'working', true)).toBe('stopped');
  });

  test('server classification maps directly', () => {
    expect(activityDotKey('running', 'waiting', false)).toBe('waiting');
    expect(activityDotKey('running', 'working', false)).toBe('working');
    expect(activityDotKey('running', 'idle', true)).toBe('idle');
  });

  test('null activity falls back to output recency', () => {
    expect(activityDotKey('running', null, true)).toBe('working');
    expect(activityDotKey('running', undefined, false)).toBe('idle');
  });
});

test('activityLabel covers every key', () => {
  expect(activityLabel('waiting')).toBe('needs input');
  expect(activityLabel('working')).toBe('working');
  expect(activityLabel('idle')).toBe('idle');
  expect(activityLabel('stopped')).toBe('stopped');
});

describe('newlyWaiting', () => {
  const row = (id: string, activity: ActivityRow['activity']): ActivityRow => ({
    id,
    status: 'running',
    activity,
  });

  test('fires on the edge into waiting, once', () => {
    const prev = new Map([['a', 'working' as const]]);
    expect(newlyWaiting(prev, [row('a', 'waiting')], null).map((r) => r.id)).toEqual(['a']);
    const prev2 = new Map([['a', 'waiting' as const]]);
    expect(newlyWaiting(prev2, [row('a', 'waiting')], null)).toEqual([]);
  });

  test('unknown previous state still fires (first sighting)', () => {
    expect(newlyWaiting(new Map(), [row('a', 'waiting')], null).length).toBe(1);
  });

  test('active session always excluded (emulator bell path owns it)', () => {
    expect(newlyWaiting(new Map(), [row('a', 'waiting')], 'a')).toEqual([]);
    expect(newlyWaiting(new Map(), [row('a', 'waiting'), row('b', 'waiting')], 'a').map((r) => r.id)).toEqual(['b']);
  });

  test('ignores non-waiting and stopped rows', () => {
    const rows: ActivityRow[] = [
      row('a', 'working'),
      row('b', 'idle'),
      { id: 'c', status: 'stopped', activity: 'waiting' },
    ];
    expect(newlyWaiting(new Map(), rows, null)).toEqual([]);
  });
});
