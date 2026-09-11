import { useEffect, useMemo, useRef, useState } from 'react';
import type { DrawerSession, HostHealthStatus } from '@/core/types';
import type { DropIntent } from '@/pane/dropZone';
import { findLeaf, firstLeafId, type PaneDir, type PaneNode, type PaneSide, type SessionRef } from '@/pane/paneTree';
import { type View, type ViewState, viewMemberKeys } from '@/pane/viewModel';
import {
  addSoloViewOp,
  closePaneOp,
  dropIntoPaneOp,
  fillPaneOp,
  focusPaneOp,
  openSessionOp,
  openViewOp,
  reconcileOp,
  setRatioOp,
  splitFromTabOp,
  splitPaneOp,
  statesEqual,
} from '@/pane/viewOps';
import { sessionKey } from '@/session/sessionKey';
import { touchLru } from '@/session/sessionLru';
import { loadViews, saveViews } from '@/settings/preferences';

export interface UseViewStateOpts {
  /** Given the CURRENT views (passed in, never captured), the live session set.
   * Takes views as an argument because the hook owns them — a getter that closed
   * over the caller's render-time views would go stale inside the effects. */
  liveKeysFor: (views: View[]) => Set<string>;
  sessions: DrawerSession[];
  healthByHost: Record<string, HostHealthStatus>;
  onFocusSession: (hostId: string, sessionId: string) => void;
}

interface PaneShortcutOpts {
  focusedPaneId: string;
  splitPane: (paneId: string, dir: PaneDir, side: PaneSide) => void;
  closePane: (paneId: string) => void;
  tree: PaneNode;
  views: View[];
  activeViewId: string;
}

/** Split/close shortcuts. Gate on Cmd, or Ctrl+Shift — never plain Ctrl+D,
 * which is the terminal's EOF and must still reach the PTY. */
function usePaneShortcuts({ focusedPaneId, splitPane, closePane, tree, views, activeViewId }: PaneShortcutOpts): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the handlers close over the current view via the listed deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = e.metaKey || (e.ctrlKey && e.shiftKey);
      if (!active) return;
      const k = e.key.toLowerCase();
      if (k === 'd') {
        e.preventDefault();
        splitPane(focusedPaneId, 'row', 'b');
      } else if (k === 'e') {
        e.preventDefault();
        splitPane(focusedPaneId, 'col', 'b');
      } else if (k === 'w') {
        e.preventDefault();
        closePane(focusedPaneId);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focusedPaneId, tree, views, activeViewId]);
}

interface OperationDeps {
  apply: (next: ViewState) => void;
  stateRef: { current: ViewState };
  liveKeysFor: () => Set<string>;
  focusedPaneId: string;
}

/** Every mutation, bound to the live state ref so none of them capture a render. */
function viewOperations({ apply, stateRef, liveKeysFor, focusedPaneId }: OperationDeps) {
  return {
    splitPane: (paneId: string, dir: PaneDir, side: PaneSide) =>
      apply(splitPaneOp(stateRef.current, paneId, dir, side)),
    closePane: (paneId: string) => apply(closePaneOp(stateRef.current, paneId, liveKeysFor())),
    focusPane: (paneId: string) => apply(focusPaneOp(stateRef.current, paneId)),
    setPaneRatio: (branchId: string, ratio: number) => apply(setRatioOp(stateRef.current, branchId, ratio)),
    fillPane: (paneId: string, ref: SessionRef) => apply(fillPaneOp(stateRef.current, paneId, ref, liveKeysFor())),
    splitFromTab: (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) =>
      apply(splitFromTabOp(stateRef.current, sessionKey(hostId, sessionId), dir, side, focusedPaneId, liveKeysFor())),
    dropIntoPane: (paneId: string, intent: DropIntent, key: string) =>
      apply(dropIntoPaneOp(stateRef.current, paneId, intent, key, liveKeysFor())),
    openView: (viewId: string) => apply(openViewOp(stateRef.current, viewId)),
    openSession: (hostId: string, sessionId: string) =>
      apply(openSessionOp(stateRef.current, hostId, sessionId, focusedPaneId, liveKeysFor())),
    addSoloView: (view: View) => apply(addSoloViewOp(stateRef.current, view)),
  };
}

export function useViewState(opts: UseViewStateOpts) {
  // Per-view layouts: solo (1 leaf) or group (2+). The active view's focused
  // pane is the app-wide active session, so git/workspace/tint keep following it.
  const initial = useMemo(() => loadViews(), []);
  const [views, setViews] = useState<View[]>(initial.views);
  const [activeViewId, setActiveViewId] = useState(initial.activeViewId);
  // Recency order of active sessions — feeds residentSessions so recently-used
  // background tabs keep a live socket (zero replay on switch-back).
  const [lruOrder, setLruOrder] = useState<string[]>([]);

  const stateRef = useRef<ViewState>({ views, activeViewId });
  stateRef.current = { views, activeViewId };
  // Held in a ref, not captured: the effects below outlive any single render,
  // and a captured getter would keep answering with the first render's sessions.
  const liveKeysForRef = useRef(opts.liveKeysFor);
  liveKeysForRef.current = opts.liveKeysFor;
  const onFocusSessionRef = useRef(opts.onFocusSession);
  onFocusSessionRef.current = opts.onFocusSession;

  const apply = (next: ViewState) => {
    stateRef.current = next;
    setViews(next.views);
    setActiveViewId(next.activeViewId);
    saveViews(next);
  };
  const liveKeysFor = () => liveKeysForRef.current(stateRef.current.views);

  const activeView = views.find((view) => view.id === activeViewId) ?? views[0];
  const tree: PaneNode = activeView?.tree ?? { kind: 'leaf', id: 'empty', session: null };
  const focusedPaneId = activeView?.focusedPaneId ?? firstLeafId(tree);
  const openSessionKeys = useMemo(() => new Set(views.flatMap((view) => viewMemberKeys(view))), [views]);
  const ops = viewOperations({ apply, stateRef, liveKeysFor, focusedPaneId });

  // Every live session belongs to exactly one view leaf.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the live session list; latest views are read from the ref
  useEffect(() => {
    const current = stateRef.current;
    const next = reconcileOp(current, liveKeysFor());
    if (!statesEqual(current, next)) apply(next);
  }, [opts.sessions, opts.healthByHost]);

  // Focused pane → active session, so the rest of the app follows the focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mirrors focus into the active session
  useEffect(() => {
    const leaf = findLeaf(tree, focusedPaneId);
    if (leaf?.session) {
      onFocusSessionRef.current(leaf.session.hostId, leaf.session.sessionId);
      const key = sessionKey(leaf.session.hostId, leaf.session.sessionId);
      setLruOrder((order) => touchLru(order, key));
    }
  }, [focusedPaneId, tree]);

  usePaneShortcuts({ focusedPaneId, splitPane: ops.splitPane, closePane: ops.closePane, tree, views, activeViewId });

  return { views, activeViewId, activeView, tree, focusedPaneId, openSessionKeys, lruOrder, ...ops };
}

export type ViewStateApi = ReturnType<typeof useViewState>;
