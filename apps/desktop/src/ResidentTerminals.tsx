import { useEffect, useMemo, useRef, useState } from 'react';
import { coreCacheDelete, coreCacheIds, coreCacheTouch } from '@/core/coreApi';
import { forgetCoreSession } from '@/core/coreTransport';
import type { DrawerSession, HostProfile } from '@/core/types';
import type { FrameApplyResult } from '@/terminal/frameHandler';
import { TerminalPane } from '@/terminal/TerminalPane';
import { AgentChatPane } from './agent/AgentChatPane';
import { EmptyPanePicker } from './EmptyPanePicker';
import { layoutTree } from './layoutRects';
import { noiseSessionAddress } from './noiseHosts';
import { PaneControls } from './PaneControls';
import { PaneDivider } from './PaneDivider';
import type { PaneDir, PaneNode, PaneSide } from './paneTree';
import type { UI_THEMES } from './preferences';
import { reconcileResidency } from './residencyReconcile';
import { residentKeys } from './residentKeys';
import { residentSessions } from './residentSessions';
import { SplitPreviewOverlay } from './SplitPreviewOverlay';
import { parseSessionKey, sessionKey } from './sessionKey';
import type { TabDropTarget } from './useTabDrag';

export interface ResidentTerminalsProps {
  hosts: HostProfile[];
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
  /** Open a past Claude session (from an agent pane's /resume) in a new tab. */
  onResumeSession: (hostId: string, cwd: string | undefined, claudeSessionId: string) => void;
  /** Live drop target during a pointer tab-drag, resolved by the parent. */
  preview: TabDropTarget | null;
  /** Most-recently-active session keys (front = newest) for background residency. */
  lruOrder: string[];
}

interface Box {
  width: number;
  height: number;
  left: number;
  top: number;
}

const RESIDENT_CAP = 8;
/** Where a non-visible resident pane parks: real size, far offscreen, inert. */
const OFFSCREEN_STYLE = {
  position: 'absolute' as const,
  left: -100000,
  top: 0,
  width: 800,
  height: 600,
  visibility: 'hidden' as const,
  pointerEvents: 'none' as const,
};

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: measures the container, keeps the resident cache in sync, and lays out slots + dividers + drop preview in one place
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

  // Sessions that keep a live socket: visible panes plus recently-active tabs,
  // capped. A tab in this set streams in the background, so switching to it
  // replays nothing.
  const resident = useMemo(
    () =>
      residentSessions({
        drawerKeys: props.sessions.filter((row) => row.kind !== 'agent').map((row) => sessionKey(row.hostId, row.id)),
        visibleKeys: residentKeys(props.tree),
        lruOrder: props.lruOrder,
        cap: RESIDENT_CAP,
      }),
    [props.sessions, props.tree, props.lruOrder],
  );
  const residentDigest = resident.join('|');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `residentDigest` is the stable digest of the resident set
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const key of resident) await coreCacheTouch(key);
      const plan = reconcileResidency({
        drawerKeys: props.sessions.map((row) => sessionKey(row.hostId, row.id)),
        wantedKeys: resident,
        cachedIds: await coreCacheIds(),
      });
      // A tab merely switched away stays a drawer key, so its cursor is kept —
      // switch-back replays only the `sinceId` delta. Only sessions gone from
      // the drawer entirely lose their snapshot and replay cursor here.
      for (const id of plan.deleteCache) await coreCacheDelete(id);
      for (const id of plan.forgetCursor) await forgetCoreSession(id);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [residentDigest, props.sessions]);

  const layout = useMemo(() => layoutTree(props.tree, box.width, box.height), [props.tree, box.width, box.height]);

  const previewRect = props.preview ? layout.leaves.find((l) => l.paneId === props.preview?.paneId)?.rect : undefined;

  const visibleBySession = new Map<string, { rect: Box; paneId: string }>();
  for (const leaf of layout.leaves) {
    if (leaf.session) {
      visibleBySession.set(sessionKey(leaf.session.hostId, leaf.session.sessionId), {
        rect: leaf.rect,
        paneId: leaf.paneId,
      });
    }
  }

  return (
    <div className="resident-terminals" ref={containerRef}>
      {/* Per-pane chrome: focus ring, controls, empty pickers, agent panes.
          Terminals live in the resident layer below so a tab switch repositions
          an existing instance instead of remounting it. */}
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
            <div key={leaf.paneId} className="pane-slot" style={style} data-pane-id={leaf.paneId} data-pane-empty="1">
              <EmptyPanePicker onPick={() => props.onPickSession(leaf.paneId)} />
            </div>
          );
        }
        const session = leaf.session;
        const host = props.hosts.find((row) => row.id === session.hostId);
        if (!host) return null;
        const drawer = props.sessions.find((row) => row.hostId === session.hostId && row.id === session.sessionId);
        // Leaf kind is durable; DrawerSession.kind is poll-transient. Either
        // marking the session agent is authoritative.
        const isAgent = session.kind === 'agent' || drawer?.kind === 'agent';
        return (
          <div
            key={leaf.paneId}
            className={`pane-slot${leaf.paneId === props.focusedPaneId ? ' focused' : ''}`}
            style={style}
            data-pane-id={leaf.paneId}
            onPointerDownCapture={() => props.onFocusPane(leaf.paneId)}
          >
            {leaf.paneId === props.focusedPaneId && (
              <PaneControls paneId={leaf.paneId} onSplit={props.onSplit} onClose={props.onClosePane} />
            )}
            {isAgent ? (
              <AgentChatPane
                hostId={session.hostId}
                sessionId={session.sessionId}
                noiseAddress={noiseSessionAddress(host)}
                cwd={session.cwd ?? drawer?.cwd ?? undefined}
                resumeSessionId={session.resumeSessionId}
                onResumeSession={(picked) =>
                  props.onResumeSession(session.hostId, session.cwd ?? drawer?.cwd ?? picked.cwd, picked.id)
                }
              />
            ) : null}
          </div>
        );
      })}

      {/* Resident terminals: one instance per resident session, keyed by session
          so a switch repositions (no remount, no socket drop). Shown into the
          pane rect, else parked offscreen but streaming. */}
      {resident.map((key) => {
        const { hostId, sessionId } = parseSessionKey(key);
        const host = props.hosts.find((row) => row.id === hostId);
        if (!host) return null;
        const shown = visibleBySession.get(key);
        const style = shown
          ? {
              position: 'absolute' as const,
              left: shown.rect.left,
              top: shown.rect.top,
              width: shown.rect.width,
              height: shown.rect.height,
            }
          : OFFSCREEN_STYLE;
        return (
          <div
            key={key}
            className="resident-terminal-holder"
            style={style}
            onPointerDownCapture={shown ? () => props.onFocusPane(shown.paneId) : undefined}
          >
            <TerminalPane
              hostId={hostId}
              sessionId={sessionId}
              interactive={!!shown && shown.paneId === props.focusedPaneId}
              noiseAddress={noiseSessionAddress(host)}
              terminalTheme={props.terminalTheme}
              fontFamily={props.fontFamily}
              fontSize={props.fontSize}
              onFrame={props.onFrame}
              onDisconnected={() => props.onDisconnected(hostId)}
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
      {previewRect && props.preview && <SplitPreviewOverlay rect={previewRect} intent={props.preview.intent} />}
    </div>
  );
}
