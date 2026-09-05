import type { DrawerSession } from './types';

/** Replace one host's rows; other hosts stay. */
export function replaceHostSessions(
  previous: DrawerSession[],
  hostId: string,
  rows: DrawerSession[],
): DrawerSession[] {
  return [...previous.filter((row) => row.hostId !== hostId), ...rows];
}

export function dropSession(
  previous: DrawerSession[],
  hostId: string,
  sessionId: string,
): DrawerSession[] {
  return previous.filter((row) => !(row.hostId === hostId && row.id === sessionId));
}

export function rememberKill(
  killed: Record<string, Set<string>>,
  hostId: string,
  sessionId: string,
): Record<string, Set<string>> {
  const hidden = new Set(killed[hostId] ?? []);
  hidden.add(sessionId);
  return { ...killed, [hostId]: hidden };
}

/**
 * Hide sessions we already killed until the server list drops them.
 *
 * A poll that raced the DELETE can return the old row; without a tombstone
 * the tab comes back and looks unkilled. Once the id is gone from the list,
 * forget the tombstone so a later `term-N` reuse can show.
 */
export function applyKillTombstones(
  hostId: string,
  rows: DrawerSession[],
  killed: Record<string, Set<string>>,
): { rows: DrawerSession[]; killed: Record<string, Set<string>> } {
  const hidden = killed[hostId];
  if (!hidden || hidden.size === 0) return { rows, killed };
  const listed = new Set(rows.map((row) => row.id));
  const visible = rows.filter((row) => !hidden.has(row.id));
  const still = new Set([...hidden].filter((id) => listed.has(id)));
  return { rows: visible, killed: { ...killed, [hostId]: still } };
}
