export type SessionActivity = 'working' | 'waiting' | 'done' | 'idle';

export type DotKey = 'stopped' | 'waiting' | 'working' | 'done' | 'idle';

export function activityDotKey(
  status: 'running' | 'stopped',
  activity: SessionActivity | null | undefined,
  live: boolean,
): DotKey {
  if (status === 'stopped') return 'stopped';
  if (activity === 'waiting') return 'waiting';
  if (activity === 'working') return 'working';
  if (activity === 'done') return 'done';
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
    case 'done':
      return 'finished';
    case 'idle':
      return 'idle';
  }
}
