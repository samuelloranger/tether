import { activityDotKey, type DotKey } from './activity';
import { isRecentlyActive } from './desktopNavigation';
import {
  closePane,
  findLeaf,
  firstLeafId,
  leaves,
  newLeaf,
  type PaneDir,
  type PaneNode,
  type PaneSide,
  type SessionRef,
  setSession,
  splitLeaf,
} from './paneTree';
import { parseSessionKey, sessionKey } from './sessionKey';
import { tabLabels } from './sessionLabel';
import type { DrawerSession, HostProfile } from './types';

export interface View {
  id: string;
  tree: PaneNode;
  focusedPaneId: string;
}

export interface ViewState {
  views: View[];
  activeViewId: string;
}

export type ViewOp =
  | { kind: 'replace'; paneId: string }
  | { kind: 'split'; paneId: string; dir: PaneDir; side: PaneSide };

export function isGroup(view: View): boolean {
  return leaves(view.tree).length >= 2;
}

export function newSoloView(session: SessionRef | null = null): View {
  const tree = newLeaf(session);
  return { id: crypto.randomUUID(), tree, focusedPaneId: tree.id };
}

function leafKey(leaf: { session: SessionRef | null }): string | null {
  if (!leaf.session) return null;
  return sessionKey(leaf.session.hostId, leaf.session.sessionId);
}

function closeOrClear(tree: PaneNode, paneId: string): PaneNode {
  if (tree.kind === 'leaf' && tree.id === paneId) {
    return { ...tree, session: null };
  }
  return closePane(tree, paneId);
}

function clearDeadLeaves(tree: PaneNode, live: Set<string>): PaneNode {
  const deadIds = leaves(tree)
    .filter((l) => {
      const key = leafKey(l);
      return key !== null && !live.has(key);
    })
    .map((l) => l.id);
  let next = tree;
  for (const id of deadIds) next = closeOrClear(next, id);
  return next;
}

function dropDuplicateLeaves(tree: PaneNode, seen: Set<string>): PaneNode {
  const extraIds: string[] = [];
  for (const l of leaves(tree)) {
    const key = leafKey(l);
    if (!key) continue;
    if (seen.has(key)) extraIds.push(l.id);
    else seen.add(key);
  }
  let next = tree;
  for (const id of extraIds) next = closeOrClear(next, id);
  return next;
}

function placedKeys(views: View[]): Set<string> {
  const keys = new Set<string>();
  for (const v of views) {
    for (const l of leaves(v.tree)) {
      const key = leafKey(l);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function isEmptySolo(view: View): boolean {
  return view.tree.kind === 'leaf' && view.tree.session === null;
}

function repairFocus(view: View): View {
  if (findLeaf(view.tree, view.focusedPaneId)) return view;
  return { ...view, focusedPaneId: firstLeafId(view.tree) };
}

function patchTree(view: View, tree: PaneNode): View {
  if (tree === view.tree) return view;
  return { ...view, tree };
}

export function reconcileViews(
  views: View[],
  liveSessionKeys: Iterable<string>,
  activeViewId: string,
): ViewState {
  const live = liveSessionKeys instanceof Set ? liveSessionKeys : new Set(liveSessionKeys);

  let next = views.map((v) => patchTree(v, clearDeadLeaves(v.tree, live)));

  const seen = new Set<string>();
  next = next.map((v) => patchTree(v, dropDuplicateLeaves(v.tree, seen)));

  const placed = placedKeys(next);
  for (const key of live) {
    if (placed.has(key)) continue;
    next = [...next, newSoloView(parseSessionKey(key))];
    placed.add(key);
  }

  const nonEmpty = next.filter((v) => !isEmptySolo(v));
  if (nonEmpty.length > 0) {
    next = nonEmpty;
  } else if (next.length > 0) {
    next = [next[0]];
  } else {
    next = [newSoloView(null)];
  }

  next = next.map(repairFocus);
  const active = next.some((v) => v.id === activeViewId) ? activeViewId : next[0].id;
  return { views: next, activeViewId: active };
}

function applyOp(tree: PaneNode, op: ViewOp, session: SessionRef): PaneNode {
  if (op.kind === 'replace') return setSession(tree, op.paneId, session);
  return splitLeaf(tree, op.paneId, op.dir, op.side, session);
}

export function moveSessionIntoView(
  views: View[],
  key: string,
  targetViewId: string,
  op: ViewOp,
  liveSessionKeys: Iterable<string>,
  activeViewId: string,
): ViewState {
  const session = parseSessionKey(key);
  let source: { viewId: string; leafId: string } | null = null;
  for (const v of views) {
    for (const l of leaves(v.tree)) {
      if (leafKey(l) === key) {
        source = { viewId: v.id, leafId: l.id };
        break;
      }
    }
    if (source) break;
  }

  let next = views;
  if (source) {
    const { viewId, leafId } = source;
    next = next.map((v) => {
      if (v.id !== viewId) return v;
      const tree = closeOrClear(v.tree, leafId);
      if (tree === v.tree) return v;
      const focusedPaneId = findLeaf(tree, v.focusedPaneId) ? v.focusedPaneId : firstLeafId(tree);
      return { ...v, tree, focusedPaneId };
    });
  }

  next = next.map((v) => {
    if (v.id !== targetViewId) return v;
    const tree = applyOp(v.tree, op, session);
    const focusedPaneId = findLeaf(tree, op.paneId) ? op.paneId : firstLeafId(tree);
    return { ...v, tree, focusedPaneId };
  });

  return reconcileViews(next, liveSessionKeys, activeViewId);
}

export function groupLabel(view: View, sessions: DrawerSession[], hosts: HostProfile[]): string {
  const labels = tabLabels(sessions, hosts);
  return leaves(view.tree)
    .flatMap((l) => {
      if (!l.session) return [];
      const key = sessionKey(l.session.hostId, l.session.sessionId);
      return [labels.get(key) ?? l.session.sessionId];
    })
    .join(' + ');
}

const DOT_RANK: Record<DotKey, number> = {
  waiting: 4,
  working: 3,
  done: 2,
  idle: 1,
  stopped: 0,
};

export function aggregateDot(view: View, sessions: DrawerSession[]): DotKey {
  const byKey = new Map(sessions.map((s) => [sessionKey(s.hostId, s.id), s]));
  let best: DotKey = 'idle';
  let bestRank = -1;
  for (const l of leaves(view.tree)) {
    if (!l.session) continue;
    const row = byKey.get(sessionKey(l.session.hostId, l.session.sessionId));
    if (!row) continue;
    const live = row.status === 'running' && isRecentlyActive(row.last_output_at);
    const key = activityDotKey(row.status, row.activity, live);
    const rank = DOT_RANK[key];
    if (rank > bestRank) {
      best = key;
      bestRank = rank;
    }
  }
  return best;
}

export function viewMemberKeys(view: View): string[] {
  return leaves(view.tree).flatMap((l) => {
    const key = leafKey(l);
    return key ? [key] : [];
  });
}

export function groupHostIds(view: View, limit = 3): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const l of leaves(view.tree)) {
    const hostId = l.session?.hostId;
    if (!hostId || seen.has(hostId)) continue;
    seen.add(hostId);
    ids.push(hostId);
    if (ids.length >= limit) break;
  }
  return ids;
}
