import { useEffect, useMemo, useRef, useState } from 'react';
import { coreCacheDelete, coreCacheIds, coreCacheTouch } from './coreApi';
import { EmptyPanePicker } from './EmptyPanePicker';
import type { FrameApplyResult } from './frameHandler';
import { layoutTree } from './layoutRects';
import { PaneDivider } from './PaneDivider';
import type { PaneDir, PaneNode, PaneSide } from './paneTree';
import type { UI_THEMES } from './preferences';
import { residentKeys } from './residentKeys';
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
}

interface Box {
  width: number;
  height: number;
  left: number;
  top: number;
}

export function ResidentTerminals(props: ResidentTerminalsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>({ width: 0, height: 0, left: 0, top: 0 });

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
            <div key={leaf.paneId} className="pane-slot" style={style}>
              <EmptyPanePicker onPick={() => props.onPickSession(leaf.paneId)} />
            </div>
          );
        }
        const session = leaf.session;
        const host = props.hosts.find((row) => row.id === session.hostId);
        if (!host) return null;
        return (
          <div
            key={leaf.paneId}
            className={`pane-slot${leaf.paneId === props.focusedPaneId ? ' focused' : ''}`}
            style={style}
            onPointerDownCapture={() => props.onFocusPane(leaf.paneId)}
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
    </div>
  );
}
