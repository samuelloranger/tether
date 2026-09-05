import type { DrawerSession } from './types';

/**
 * Running sessions only: opening a WS calls `startSession`, so restoring onto a
 * stopped row would resurrect a shell the user had killed. Reopening starts nothing.
 */
export function restorableIds(sessions: DrawerSession[], hostId: string): string[] {
  return sessions
    .filter((row) => row.hostId === hostId && row.status === 'running')
    .map((row) => row.id);
}

/**
 * The remembered session while alive, else the host's first — a running session the
 * user can't see is one they won't know about. null means the host genuinely has none.
 */
export function pickResume(remembered: string | null, available: string[]): string | null {
  if (remembered && available.includes(remembered)) return remembered;
  return available[0] ?? null;
}
