export interface SessionRef {
  hostId: string;
  sessionId: string;
}
export type PaneDir = 'row' | 'col';
export type PaneSide = 'a' | 'b';
export interface Leaf {
  kind: 'leaf';
  id: string;
  session: SessionRef | null;
}
export interface Branch {
  kind: 'branch';
  id: string;
  dir: PaneDir;
  a: PaneNode;
  b: PaneNode;
  ratio: number;
}
export type PaneNode = Leaf | Branch;

export const MIN_RATIO = 0.1;

export function newLeaf(session: SessionRef | null = null): Leaf {
  return { kind: 'leaf', id: crypto.randomUUID(), session };
}

export function leaves(tree: PaneNode): Leaf[] {
  if (tree.kind === 'leaf') return [tree];
  return [...leaves(tree.a), ...leaves(tree.b)];
}

export function findLeaf(tree: PaneNode, paneId: string): Leaf | null {
  if (tree.kind === 'leaf') return tree.id === paneId ? tree : null;
  return findLeaf(tree.a, paneId) ?? findLeaf(tree.b, paneId);
}

export function firstLeafId(tree: PaneNode): string {
  return tree.kind === 'leaf' ? tree.id : firstLeafId(tree.a);
}

function mapTree(tree: PaneNode, fn: (leaf: Leaf) => PaneNode): PaneNode {
  if (tree.kind === 'leaf') return fn(tree);
  const a = mapTree(tree.a, fn);
  const b = mapTree(tree.b, fn);
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

export function splitLeaf(
  tree: PaneNode,
  targetPaneId: string,
  dir: PaneDir,
  side: PaneSide,
  session: SessionRef | null,
): PaneNode {
  if (!findLeaf(tree, targetPaneId)) return tree;
  return mapTree(tree, (leaf) => {
    if (leaf.id !== targetPaneId) return leaf;
    const created = newLeaf(session);
    const branch: Branch = {
      kind: 'branch',
      id: crypto.randomUUID(),
      dir,
      a: side === 'a' ? created : leaf,
      b: side === 'a' ? leaf : created,
      ratio: 0.5,
    };
    return branch;
  });
}

export function closePane(tree: PaneNode, paneId: string): PaneNode {
  if (tree.kind === 'leaf') return tree.id === paneId ? newLeaf() : tree;
  if (tree.a.kind === 'leaf' && tree.a.id === paneId) return tree.b;
  if (tree.b.kind === 'leaf' && tree.b.id === paneId) return tree.a;
  const a = closePane(tree.a, paneId);
  const b = closePane(tree.b, paneId);
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

export function setSession(tree: PaneNode, paneId: string, session: SessionRef | null): PaneNode {
  if (!findLeaf(tree, paneId)) return tree;
  return mapTree(tree, (leaf) => (leaf.id === paneId ? { ...leaf, session } : leaf));
}

export function setRatio(tree: PaneNode, branchId: string, ratio: number): PaneNode {
  if (tree.kind === 'leaf') return tree;
  if (tree.id === branchId) {
    const clamped = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
    return { ...tree, ratio: clamped };
  }
  const a = setRatio(tree.a, branchId, ratio);
  const b = setRatio(tree.b, branchId, ratio);
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}
