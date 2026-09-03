import type { Branch, PaneNode } from './paneTree';
import { sessionKey } from './sessionKey';

export function serializePaneTree(tree: PaneNode): string {
  return JSON.stringify(tree);
}

function isValid(node: unknown): node is PaneNode {
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (n.kind === 'leaf') return typeof n.id === 'string';
  if (n.kind === 'branch') {
    return (
      typeof n.id === 'string' &&
      (n.dir === 'row' || n.dir === 'col') &&
      typeof n.ratio === 'number' &&
      isValid(n.a) &&
      isValid(n.b)
    );
  }
  return false;
}

export function deserializePaneTree(json: string | null): PaneNode | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function prunePaneTree(tree: PaneNode, liveKeys: Set<string>): PaneNode {
  if (tree.kind === 'leaf') {
    if (tree.session && !liveKeys.has(sessionKey(tree.session.hostId, tree.session.sessionId))) {
      return { ...tree, session: null };
    }
    return tree;
  }
  const branch = tree as Branch;
  const a = prunePaneTree(branch.a, liveKeys);
  const b = prunePaneTree(branch.b, liveKeys);
  return a === branch.a && b === branch.b ? tree : { ...branch, a, b };
}
