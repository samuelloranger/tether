import type { DrawerSession } from './types';

/**
 * Which terminal a cold launch — or a host switch — is allowed to open.
 *
 * Running only. `/api/sessions` deliberately lists stopped sessions too, and
 * opening a WebSocket for an id calls `startSession` on the server: restoring
 * onto a stopped row would spawn a fresh shell under it and resurrect a
 * terminal the user had killed. Coming back to the app must never start
 * anything.
 */
export function restorableIds(sessions: DrawerSession[], hostId: string): string[] {
  return sessions
    .filter((row) => row.hostId === hostId && row.status === 'running')
    .map((row) => row.id);
}

/**
 * The remembered session while it is still alive, otherwise the first one the
 * host reports.
 *
 * Falling back to the first rather than to nothing is deliberate: a session the
 * user cannot see is a session they will not know is running. null means the
 * host genuinely has none, which is the empty state's job — not a reason to
 * invent `term-1`.
 */
export function pickResume(remembered: string | null, available: string[]): string | null {
  if (remembered && available.includes(remembered)) return remembered;
  return available[0] ?? null;
}
