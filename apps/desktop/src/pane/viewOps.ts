import type { DropIntent } from '@/pane/dropZone';
import {
  closePane,
  findLeaf,
  firstLeafId,
  leaves,
  type PaneDir,
  type PaneSide,
  type SessionRef,
  setRatio,
  setSession,
  splitLeaf,
} from '@/pane/paneTree';
import { moveSessionIntoView, reconcileViews, type View, type ViewState, viewMemberKeys } from '@/pane/viewModel';
import { serializeViews } from '@/pane/viewsSerialize';
import { sessionKey } from '@/session/sessionKey';

export function statesEqual(a: ViewState, b: ViewState): boolean {
  return serializeViews(a) === serializeViews(b);
}

export function patchActiveView(views: View[], activeViewId: string, patch: (view: View) => View): View[] {
  return views.map((view) => (view.id === activeViewId ? patch(view) : view));
}

export function splitPaneOp(state: ViewState, paneId: string, dir: PaneDir, side: PaneSide): ViewState {
  return {
    views: patchActiveView(state.views, state.activeViewId, (view) => ({
      ...view,
      tree: splitLeaf(view.tree, paneId, dir, side, null),
    })),
    activeViewId: state.activeViewId,
  };
}

export function closePaneOp(state: ViewState, paneId: string, liveKeys: Set<string>): ViewState {
  const nextViews = patchActiveView(state.views, state.activeViewId, (view) => {
    const nextTree = closePane(view.tree, paneId);
    return {
      ...view,
      tree: nextTree,
      focusedPaneId: findLeaf(nextTree, view.focusedPaneId) ? view.focusedPaneId : firstLeafId(nextTree),
    };
  });
  return reconcileViews(nextViews, liveKeys, state.activeViewId);
}

export function fillPaneOp(state: ViewState, paneId: string, ref: SessionRef, liveKeys: Set<string>): ViewState {
  const nextViews = patchActiveView(state.views, state.activeViewId, (view) => ({
    ...view,
    tree: setSession(view.tree, paneId, ref),
    focusedPaneId: paneId,
  }));
  return reconcileViews(nextViews, liveKeys, state.activeViewId);
}

export function focusPaneOp(state: ViewState, paneId: string): ViewState {
  return {
    views: patchActiveView(state.views, state.activeViewId, (view) => ({ ...view, focusedPaneId: paneId })),
    activeViewId: state.activeViewId,
  };
}

export function setRatioOp(state: ViewState, branchId: string, ratio: number): ViewState {
  return {
    views: patchActiveView(state.views, state.activeViewId, (view) => ({
      ...view,
      tree: setRatio(view.tree, branchId, ratio),
    })),
    activeViewId: state.activeViewId,
  };
}

export function splitFromTabOp(
  state: ViewState,
  key: string,
  dir: PaneDir,
  side: PaneSide,
  fallbackPaneId: string,
  liveKeys: Set<string>,
): ViewState {
  return moveSessionIntoView(
    state.views,
    key,
    state.activeViewId,
    {
      kind: 'split',
      paneId: state.views.find((view) => view.id === state.activeViewId)?.focusedPaneId ?? fallbackPaneId,
      dir,
      side,
    },
    liveKeys,
    state.activeViewId,
  );
}

export function dropIntoPaneOp(
  state: ViewState,
  paneId: string,
  intent: DropIntent,
  key: string,
  liveKeys: Set<string>,
): ViewState {
  const op =
    intent.kind === 'replace'
      ? { kind: 'replace' as const, paneId }
      : { kind: 'split' as const, paneId, dir: intent.dir, side: intent.side };
  return moveSessionIntoView(state.views, key, state.activeViewId, op, liveKeys, state.activeViewId);
}

export function openViewOp(state: ViewState, viewId: string): ViewState {
  if (state.activeViewId === viewId) return state;
  return { views: state.views, activeViewId: viewId };
}

export function openSessionOp(
  state: ViewState,
  hostId: string,
  sessionId: string,
  fallbackPaneId: string,
  liveKeys: Set<string>,
): ViewState {
  const key = sessionKey(hostId, sessionId);
  const existing = state.views.find((view) => viewMemberKeys(view).includes(key));
  if (existing) {
    const pane = leaves(existing.tree).find(
      (leaf) => leaf.session && sessionKey(leaf.session.hostId, leaf.session.sessionId) === key,
    );
    return {
      views: state.views.map((view) => (view.id === existing.id && pane ? { ...view, focusedPaneId: pane.id } : view)),
      activeViewId: existing.id,
    };
  }
  return fillPaneOp(state, fallbackPaneId, { hostId, sessionId }, liveKeys);
}

export function addSoloViewOp(state: ViewState, view: View): ViewState {
  return { views: [...state.views, view], activeViewId: view.id };
}

export function reconcileOp(state: ViewState, liveKeys: Set<string>): ViewState {
  return reconcileViews(state.views, liveKeys, state.activeViewId);
}
