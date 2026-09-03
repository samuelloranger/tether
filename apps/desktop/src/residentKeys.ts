import { leaves, type PaneNode } from './paneTree';
import { sessionKey } from './sessionKey';

export function residentKeys(tree: PaneNode): string[] {
  return leaves(tree)
    .filter((leaf) => leaf.session)
    .map((leaf) => sessionKey(leaf.session!.hostId, leaf.session!.sessionId));
}
