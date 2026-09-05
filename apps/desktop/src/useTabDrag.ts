import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type DropIntent, dropIntent } from './dropZone';

/**
 * Pointer-driven "drag a session tab into a pane". Not HTML5 DnD: Tauri's native drag-drop
 * handler swallows in-webview drags on Windows, so we track the pointer and hit-test panes.
 */

const DRAG_THRESHOLD_PX = 5;

export type BeginTabDrag = (
  e: React.PointerEvent,
  hostId: string,
  sessionId: string,
  label: string,
) => void;

export interface TabDropTarget {
  paneId: string;
  intent: DropIntent;
}

export interface TabDragState {
  /** sessionKey (`<hostId>:<sessionId>`) being dragged. */
  key: string;
  label: string;
  /** Live pointer position, viewport coordinates. */
  x: number;
  y: number;
  target: TabDropTarget | null;
}

/** Where a point lands inside one pane (pure/testable): an empty pane only
 *  replaces; a filled pane splits at its edges or replaces near the center. */
export function paneDropTarget(
  paneId: string,
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
  empty: boolean,
): TabDropTarget {
  if (empty) return { paneId, intent: { kind: 'replace' } };
  const intent = dropIntent(x - rect.left, y - rect.top, {
    left: 0,
    top: 0,
    width: rect.width,
    height: rect.height,
  });
  return { paneId, intent };
}

function resolveTarget(x: number, y: number): TabDropTarget | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest<HTMLElement>('[data-pane-id]');
  const paneId = pane?.dataset.paneId;
  if (!pane || !paneId) return null;
  const r = pane.getBoundingClientRect();
  return paneDropTarget(paneId, r, x, y, pane.dataset.paneEmpty === '1');
}

export function useTabDrag(onDrop: (paneId: string, intent: DropIntent, key: string) => void) {
  const [drag, setDrag] = useState<TabDragState | null>(null);
  const pending = useRef<{ key: string; label: string; startX: number; startY: number } | null>(
    null,
  );
  const dragRef = useRef<TabDragState | null>(null);
  dragRef.current = drag;

  const begin = useCallback<BeginTabDrag>((e, hostId, sessionId, label) => {
    if (e.button !== 0) return; // left button only
    // A press on one of the row's own action buttons (kill/rename) is a click.
    if ((e.target as HTMLElement).closest('[data-tab-action]')) return;
    pending.current = {
      key: `${hostId}:${sessionId}`,
      label,
      startX: e.clientX,
      startY: e.clientY,
    };
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = pending.current;
      if (p && !dragRef.current) {
        if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < DRAG_THRESHOLD_PX) return;
        setDrag({
          key: p.key,
          label: p.label,
          x: e.clientX,
          y: e.clientY,
          target: resolveTarget(e.clientX, e.clientY),
        });
        return;
      }
      if (dragRef.current) {
        setDrag(
          (d) =>
            d && { ...d, x: e.clientX, y: e.clientY, target: resolveTarget(e.clientX, e.clientY) },
        );
      }
    };
    const up = () => {
      const d = dragRef.current;
      pending.current = null;
      if (!d) return;
      if (d.target) onDrop(d.target.paneId, d.target.intent, d.key);
      setDrag(null);
    };
    const cancel = () => {
      pending.current = null;
      if (dragRef.current) setDrag(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [onDrop]);

  return { drag, begin };
}
