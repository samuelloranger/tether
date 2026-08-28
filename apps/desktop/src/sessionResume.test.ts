import { describe, expect, test } from 'bun:test';
import { pickResume, restorableIds } from './sessionResume';
import type { DrawerSession } from './types';

function row(id: string, hostId: string, status: 'running' | 'stopped'): DrawerSession {
  return { hostId, id, status, last_output_at: null };
}

describe('restorableIds', () => {
  test('keeps running sessions of the host only', () => {
    const rows = [
      row('term-1', 'a', 'running'),
      row('term-2', 'a', 'stopped'),
      row('term-3', 'b', 'running'),
    ];
    expect(restorableIds(rows, 'a')).toEqual(['term-1']);
  });

  test('a host with nothing running restores nothing', () => {
    expect(restorableIds([row('term-1', 'a', 'stopped')], 'a')).toEqual([]);
  });
});

describe('pickResume', () => {
  test('prefers the remembered session while it is alive', () => {
    expect(pickResume('term-2', ['term-1', 'term-2'])).toBe('term-2');
  });

  test('falls back to the first when the remembered one is gone', () => {
    expect(pickResume('term-9', ['term-1', 'term-2'])).toBe('term-1');
  });

  test('nothing remembered takes the first', () => {
    expect(pickResume(null, ['term-4'])).toBe('term-4');
  });

  test('no running session opens none', () => {
    expect(pickResume('term-1', [])).toBeNull();
  });
});
