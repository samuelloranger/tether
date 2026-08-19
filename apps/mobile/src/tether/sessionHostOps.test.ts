import { describe, expect, test } from 'bun:test';
import type { DrawerSession } from '../SessionDrawer';
import type { SessionCache } from '../sessionCache';
import type { HostClient } from './hostClient';
import { killActiveSession } from './sessionHostOps';

// The kill path awaits two round-trips (kill, then refresh). The active tab can
// change under it while those are in flight, so the harness lets a test flip the
// active key at a chosen await point.
function harness(options: {
  drawerSessions: DrawerSession[];
  activeKey: string;
  onKill?: () => void;
  onRefresh?: () => void;
}) {
  let activeKey = options.activeKey;
  const effects = {
    deleted: [] as string[],
    disconnected: [] as string[],
    clearedPresentation: 0,
    switched: [] as Array<{ hostId: string; id: string }>,
  };

  const run = (id: string, hostId: string) =>
    killActiveSession({
      id,
      hostId,
      getActiveKey: () => activeKey,
      client: {
        post: async () => {
          options.onKill?.();
          return new Response('{}');
        },
      } as unknown as HostClient,
      cache: {
        delete: (key: string) => {
          effects.deleted.push(key);
        },
      } as unknown as SessionCache,
      drawerSessions: options.drawerSessions,
      disconnect: (key) => effects.disconnected.push(key),
      refreshSessions: async () => {
        options.onRefresh?.();
      },
      onClearPresentation: () => effects.clearedPresentation++,
      switchTo: (hostId, id) => effects.switched.push({ hostId, id }),
    });

  return {
    run,
    effects,
    setActiveKey: (key: string) => {
      activeKey = key;
    },
  };
}

const rows: DrawerSession[] = [
  { hostId: 'host-1', id: 'term-1', status: 'running', last_output_at: null },
  { hostId: 'host-1', id: 'term-2', status: 'running', last_output_at: null },
];

describe('killActiveSession', () => {
  test('switches to the next session when the killed tab is still active', async () => {
    const h = harness({ drawerSessions: rows, activeKey: 'host-1:term-1' });
    await h.run('term-1', 'host-1');
    expect(h.effects.deleted).toEqual(['host-1:term-1']);
    expect(h.effects.disconnected).toEqual(['host-1:term-1']);
    expect(h.effects.clearedPresentation).toBe(1);
    expect(h.effects.switched).toEqual([{ hostId: 'host-1', id: 'term-2' }]);
  });

  test('falls back to term-1 when nothing remains', async () => {
    const only: DrawerSession[] = [rows[0] as DrawerSession];
    const h = harness({ drawerSessions: only, activeKey: 'host-1:term-1' });
    await h.run('term-1', 'host-1');
    expect(h.effects.switched).toEqual([{ hostId: 'host-1', id: 'term-1' }]);
  });

  test('leaves a background kill alone', async () => {
    const h = harness({ drawerSessions: rows, activeKey: 'host-1:term-2' });
    await h.run('term-1', 'host-1');
    expect(h.effects.disconnected).toEqual(['host-1:term-1']);
    expect(h.effects.clearedPresentation).toBe(0);
    expect(h.effects.switched).toEqual([]);
  });

  // Regression: the active key used to be snapshotted before the awaits, so a tab
  // switch mid-kill still matched and yanked the user off the tab they picked.
  test('does not switch when the user changed tabs during the kill request', async () => {
    const h = harness({
      drawerSessions: rows,
      activeKey: 'host-1:term-1',
      onKill: () => h.setActiveKey('host-1:term-2'),
    });
    await h.run('term-1', 'host-1');
    expect(h.effects.clearedPresentation).toBe(0);
    expect(h.effects.switched).toEqual([]);
  });

  test('does not switch when the user changed tabs during the refresh', async () => {
    const h = harness({
      drawerSessions: rows,
      activeKey: 'host-1:term-1',
      onRefresh: () => h.setActiveKey('host-1:term-2'),
    });
    await h.run('term-1', 'host-1');
    expect(h.effects.clearedPresentation).toBe(0);
    expect(h.effects.switched).toEqual([]);
  });
});
