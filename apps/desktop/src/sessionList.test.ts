import { describe, expect, test } from 'bun:test';
import { applyKillTombstones, dropSession, rememberKill, replaceHostSessions } from './sessionList';
import type { DrawerSession } from './types';

function row(id: string, hostId = 'box'): DrawerSession {
  return { hostId, id, status: 'running', last_output_at: null };
}

describe('replaceHostSessions', () => {
  test('a cold fetch fills that host without touching the other', () => {
    const previous = [row('term-9', 'other')];
    const listed = [row('term-1'), row('term-3')];
    expect(replaceHostSessions(previous, 'box', listed).map((r) => `${r.hostId}:${r.id}`)).toEqual([
      'other:term-9',
      'box:term-1',
      'box:term-3',
    ]);
  });
});

describe('applyKillTombstones', () => {
  test('a stale list after kill cannot resurrect the row', () => {
    const killed = rememberKill({}, 'box', 'term-3');
    const listed = [row('term-1'), row('term-3')];
    const { rows, killed: next } = applyKillTombstones('box', listed, killed);
    expect(rows.map((r) => r.id)).toEqual(['term-1']);
    expect([...next.box]).toEqual(['term-3']);
  });

  test('once the server omits the id the tombstone clears', () => {
    const killed = rememberKill({}, 'box', 'term-3');
    const { rows, killed: next } = applyKillTombstones('box', [row('term-1')], killed);
    expect(rows.map((r) => r.id)).toEqual(['term-1']);
    expect(next.box.size).toBe(0);
  });
});

describe('dropSession', () => {
  test('removes only that host+id', () => {
    const previous = [row('term-1'), row('term-3'), row('term-1', 'other')];
    expect(dropSession(previous, 'box', 'term-3').map((r) => `${r.hostId}:${r.id}`)).toEqual([
      'box:term-1',
      'other:term-1',
    ]);
  });
});
