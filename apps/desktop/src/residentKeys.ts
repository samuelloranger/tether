import { leaves, type PaneNode } from './paneTree';
import { sessionKey } from './sessionKey';

export function residentKeys(tree: PaneNode): string[] {
  const keys: string[] = [];
  for (const leaf of leaves(tree)) {
    if (leaf.session) keys.push(sessionKey(leaf.session.hostId, leaf.session.sessionId));
  }
  return keys;
}
