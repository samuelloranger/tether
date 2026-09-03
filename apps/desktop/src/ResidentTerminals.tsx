import { useEffect, useMemo, useRef, useState } from 'react';
import { coreCacheDelete, coreCacheIds, coreCacheTouch } from './coreApi';
import { type DropIntent, dropIntent, SESSION_DND_MIME } from './dropZone';
import { EmptyPanePicker } from './EmptyPanePicker';
import type { FrameApplyResult } from './frameHandler';
import { layoutTree, type Rect } from './layoutRects';
import { PaneDivider } from './PaneDivider';
import type { PaneDir, PaneNode, PaneSide } from './paneTree';
import type { UI_THEMES } from './preferences';
import { residentKeys } from './residentKeys';
import { SplitPreviewOverlay } from './SplitPreviewOverlay';
import { sessionKey } from './sessionKey';
import { TerminalPane } from './TerminalPane';
import type { DrawerSession, HostProfile } from './types';
import { wsOriginFor } from './types';

export interface ResidentTerminalsProps {
  hosts: HostProfile[];
  passwords: Record<string, string>;
  sessions: DrawerSession[];
  tree: PaneNode;
  focusedPaneId: string;
  terminalTheme: (typeof UI_THEMES)[keyof typeof UI_THEMES]['terminal'];
  fontFamily: string;
  fontSize?: number;
  onFrame: (hostId: string, sessionId: string, frame: FrameApplyResult) => void;
  onDisconnected: (hostId: string) => void;
  onFocusPane: (paneId: string) => void;
  onSetRatio: (branchId: string, ratio: number) => void;
  onPickSession: (paneId: string) => void;
  onSplit: (paneId: string, dir: PaneDir, side: PaneSide) => void;
  onClosePane: (paneId: string) => void;
  onDropSession: (paneId: string, intent: DropIntent, key: string) => void;
}

interface DragHover {
  paneId: string;
  rect: Rect;
  intent: DropIntent;
}

interface Box {
  width: number;
  height: number;
  left: number;
  top: number;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: measures the container, keeps the resident cache in sync, and lays out slots + dividers + drop preview in one place
export function ResidentTerminals(props: ResidentTerminalsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>({ width: 0, height: 0, left: 0, top: 0 });
  const [hover, setHover] = useState<DragHover | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setBox({ width: el.clientWidth, height: el.clientHeight, left: rect.left, top: rect.top });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);

  const keys = useMemo(() => residentKeys(props.tree).join('|'), [props.tree]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `keys` is the stable digest of the tree's session set
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const key of residentKeys(props.tree)) await coreCacheTouch(key);
      const valid = new Set(props.sessions.map((row) => sessionKey(row.hostId, row.id)));
      const wanted = new Set(residentKeys(props.tree));
      const ids = await coreCacheIds();
      for (const id of ids) {
        if (!valid.has(id) && !wanted.has(id)) await coreCacheDelete(id);
      }
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [keys, props.sessions]);

  const layout = useMemo(
    () => layoutTree(props.tree, box.width, box.height),
    [props.tree, box.width, box.height],
  );

  return (
    <div className="resident-terminals" ref={containerRef}>
      {/* biome-ignore lint/complexity/noExcessiveLinesPerFunction: per-leaf render — positioning, drag/drop wiring, and pane controls */}
      {layout.leaves.map((leaf) => {
        const style = {
          position: 'absolute' as const,
          left: leaf.rect.left,
          top: leaf.rect.top,
          width: leaf.rect.width,
          height: leaf.rect.height,
        };
        if (!leaf.session) {
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: pane is a pointer drop target for dragged session tabs
            <div
              key={leaf.paneId}
              className="pane-slot"
              style={style}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(SESSION_DND_MIME)) return;
                e.preventDefault();
              }}
              onDrop={(e) => {
                const key = e.dataTransfer.getData(SESSION_DND_MIME);
                if (!key) return;
                e.preventDefault();
                props.onDropSession(leaf.paneId, { kind: 'replace' }, key);
              }}
            >
              <EmptyPanePicker onPick={() => props.onPickSession(leaf.paneId)} />
            </div>
          );
        }
        const session = leaf.session;
        const host = props.hosts.find((row) => row.id === session.hostId);
        if (!host) return null;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: pane focuses on pointer-down and is a drop target for dragged session tabs
          <div
            key={leaf.paneId}
            className={`pane-slot${leaf.paneId === props.focusedPaneId ? ' focused' : ''}`}
            style={style}
            onPointerDownCapture={() => props.onFocusPane(leaf.paneId)}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(SESSION_DND_MIME)) return;
              e.preventDefault();
              const b = e.currentTarget.getBoundingClientRect();
              const local: Rect = { left: 0, top: 0, width: b.width, height: b.height };
              setHover({
                paneId: leaf.paneId,
                rect: leaf.rect,
                intent: dropIntent(e.clientX - b.left, e.clientY - b.top, local),
              });
            }}
            onDragLeave={() => setHover((h) => (h?.paneId === leaf.paneId ? null : h))}
            onDrop={(e) => {
              const key = e.dataTransfer.getData(SESSION_DND_MIME);
              const current = hover;
              setHover(null);
              if (!key) return;
              e.preventDefault();
              const b = e.currentTarget.getBoundingClientRect();
              const local: Rect = { left: 0, top: 0, width: b.width, height: b.height };
              const intent =
                current?.paneId === leaf.paneId
                  ? current.intent
                  : dropIntent(e.clientX - b.left, e.clientY - b.top, local);
              props.onDropSession(leaf.paneId, intent, key);
            }}
          >
            {leaf.paneId === props.focusedPaneId && (
              <div className="pane-controls">
                <button
                  type="button"
                  title="Split right"
                  onClick={() => props.onSplit(leaf.paneId, 'row', 'b')}
                >
                  ⬒
                </button>
                <button
                  type="button"
                  title="Split down"
                  onClick={() => props.onSplit(leaf.paneId, 'col', 'b')}
                >
                  ⬓
                </button>
                <button
                  type="button"
                  title="Close pane"
                  onClick={() => props.onClosePane(leaf.paneId)}
                >
                  ✕
                </button>
              </div>
            )}
            <TerminalPane
              hostId={session.hostId}
              sessionId={session.sessionId}
              interactive={leaf.paneId === props.focusedPaneId}
              wsOrigin={wsOriginFor(host)}
              password={props.passwords[session.hostId] ?? ''}
              terminalTheme={props.terminalTheme}
              fontFamily={props.fontFamily}
              fontSize={props.fontSize}
              onFrame={props.onFrame}
              onDisconnected={() => props.onDisconnected(session.hostId)}
            />
          </div>
        );
      })}
      {layout.dividers.map((divider) => (
        <PaneDivider
          key={divider.branchId}
          divider={divider}
          containerOrigin={{ left: box.left, top: box.top }}
          onRatio={(ratio) => props.onSetRatio(divider.branchId, ratio)}
        />
      ))}
      {hover && <SplitPreviewOverlay rect={hover.rect} intent={hover.intent} />}
    </div>
  );
}
