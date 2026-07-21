// Client-side model for the server's per-session activity classification
// (see apps/server/src/server/sessionActivity.ts). Pure helpers so the badge
// color and notification decisions are unit-testable without React.

export type SessionActivity = 'working' | 'waiting' | 'idle';

export interface ActivityRow {
  id: string;
  status: 'running' | 'stopped';
  activity?: SessionActivity | null;
  name?: string | null;
}

export type DotKey = 'stopped' | 'waiting' | 'working' | 'idle';

// Which drawer dot to show. `live` is the pre-existing recency fallback used
// when the server reports no classification (e.g. right after a restart).
export function activityDotKey(
  status: 'running' | 'stopped',
  activity: SessionActivity | null | undefined,
  live: boolean,
): DotKey {
  if (status === 'stopped') return 'stopped';
  if (activity === 'waiting') return 'waiting';
  if (activity === 'working') return 'working';
  if (activity === 'idle') return 'idle';
  return live ? 'working' : 'idle';
}

export function activityLabel(key: DotKey): string {
  switch (key) {
    case 'stopped':
      return 'stopped';
    case 'waiting':
      return 'needs input';
    case 'working':
      return 'working';
    case 'idle':
      return 'idle';
  }
}

// Background sessions that just flipped to `waiting` and deserve a
// notification. Only fires on a working/idle/unknown → waiting edge, so a
// still-waiting session doesn't re-notify on every 4s poll. The ACTIVE
// session is always excluded: its alerts belong to the focus-aware emulator
// bell path in useTetherApp (which sees blur/hidden), and handling it here
// too would double-notify on every agent prompt.
export function newlyWaiting(
  prev: ReadonlyMap<string, SessionActivity | null | undefined>,
  rows: ActivityRow[],
  activeId: string | null,
): ActivityRow[] {
  return rows.filter((row) => {
    if (row.status !== 'running' || row.activity !== 'waiting') return false;
    if (prev.get(row.id) === 'waiting') return false;
    if (row.id === activeId) return false;
    return true;
  });
}
