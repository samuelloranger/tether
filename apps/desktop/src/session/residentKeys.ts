import type { DrawerSession, HostHealthStatus } from '@/core/types';
import { leaves, type PaneNode } from '@/pane/paneTree';
import type { View } from '@/pane/viewModel';
import { sessionKey } from './sessionKey';

export function residentKeys(tree: PaneNode): string[] {
  const keys: string[] = [];
  for (const leaf of leaves(tree)) {
    if (leaf.session) keys.push(sessionKey(leaf.session.hostId, leaf.session.sessionId));
  }
  return keys;
}

/** Live session keys, plus any leaf on a host whose health is still unknown —
 * without that, a slow-to-report host's panes would be reconciled away. */
export function liveSessionKeys(
  sessions: DrawerSession[],
  views: View[],
  healthByHost: Record<string, HostHealthStatus>,
): Set<string> {
  const live = new Set(sessions.map((row) => sessionKey(row.hostId, row.id)));
  const known = new Set(
    Object.entries(healthByHost)
      .filter(([, status]) => status !== 'unknown')
      .map(([id]) => id),
  );
  for (const view of views) {
    for (const leaf of leaves(view.tree)) {
      if (!leaf.session) continue;
      if (!known.has(leaf.session.hostId)) {
        live.add(sessionKey(leaf.session.hostId, leaf.session.sessionId));
      }
    }
  }
  return live;
}
