import type { PaneDir, PaneNode, SessionRef } from './paneTree';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface LeafRect {
  paneId: string;
  session: SessionRef | null;
  rect: Rect;
}
export interface DividerRect {
  branchId: string;
  dir: PaneDir;
  rect: Rect;
}
export interface Layout {
  leaves: LeafRect[];
  dividers: DividerRect[];
}

export const DIVIDER_PX = 6;

export function layoutTree(
  tree: PaneNode,
  width: number,
  height: number,
  dividerPx: number = DIVIDER_PX,
): Layout {
  const out: Layout = { leaves: [], dividers: [] };
  walk(tree, { left: 0, top: 0, width, height }, dividerPx, out);
  return out;
}

function walk(node: PaneNode, rect: Rect, dividerPx: number, out: Layout): void {
  if (node.kind === 'leaf') {
    out.leaves.push({ paneId: node.id, session: node.session, rect });
    return;
  }
  if (node.dir === 'row') {
    const avail = Math.max(0, rect.width - dividerPx);
    const aw = avail * node.ratio;
    const aRect: Rect = { ...rect, width: aw };
    const dRect: Rect = {
      left: rect.left + aw,
      top: rect.top,
      width: dividerPx,
      height: rect.height,
    };
    const bRect: Rect = {
      left: rect.left + aw + dividerPx,
      top: rect.top,
      width: avail - aw,
      height: rect.height,
    };
    out.dividers.push({ branchId: node.id, dir: 'row', rect: dRect });
    walk(node.a, aRect, dividerPx, out);
    walk(node.b, bRect, dividerPx, out);
  } else {
    const avail = Math.max(0, rect.height - dividerPx);
    const ah = avail * node.ratio;
    const aRect: Rect = { ...rect, height: ah };
    const dRect: Rect = {
      left: rect.left,
      top: rect.top + ah,
      width: rect.width,
      height: dividerPx,
    };
    const bRect: Rect = {
      left: rect.left,
      top: rect.top + ah + dividerPx,
      width: rect.width,
      height: avail - ah,
    };
    out.dividers.push({ branchId: node.id, dir: 'col', rect: dRect });
    walk(node.a, aRect, dividerPx, out);
    walk(node.b, bRect, dividerPx, out);
  }
}
