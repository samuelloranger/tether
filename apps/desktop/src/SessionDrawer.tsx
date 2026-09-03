import { useState } from 'react';
import { activityDotKey, activityLabel } from './activity';
import { isRecentlyActive } from './desktopNavigation';
import { SESSION_DND_MIME } from './dropZone';
import type { PaneDir, PaneSide } from './paneTree';
import { sessionKey } from './sessionKey';
import { sessionLabel, sessionLabels } from './sessionLabel';
import { TabContextMenu } from './TabContextMenu';
import type { DrawerSession, HostHealthStatus, HostProfile } from './types';

interface SessionDrawerProps {
  hosts: HostProfile[];
  healthByHost: Record<string, HostHealthStatus>;
  sessions: DrawerSession[];
  activeHostId: string | null;
  activeSessionId: string;
  docked?: boolean;
  showPin?: boolean;
  sidebarPinned?: boolean;
  onTogglePin?: () => void;
  onSelect: (hostId: string, sessionId: string) => void;
  /** Per host: a single global button can only mean "the active host". */
  onNew: (hostId: string) => void;
  onRequestKill: (hostId: string, sessionId: string, label: string) => void;
  onRequestRename: (hostId: string, sessionId: string, text: string, placeholder: string) => void;
  onRetryHost: (hostId: string) => void;
  onReenterPassword: (hostId: string) => void;
  onOpenHosts: () => void;
  onOpenSettings: () => void;
  onOpenHostSettings: (hostId: string) => void;
  onSplitFromTab?: (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) => void;
}

// The app icon's glyph at toolbar size: the prompt chevron and the cursor
// block, in the icon's own green and indigo. Drawn rather than imported so it
// stays crisp at 20px and needs no asset pipeline. The icon's dark tile is
// dropped — the drawer is already that colour — and the glyph grown to fill the
// space the tile used to take, or it reads as a speck next to the wordmark.
function TetherMark() {
  return (
    <svg className="drawer-mark" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4.8 6.6 10.6 12l-5.8 5.4"
        stroke="#37de9f"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="14.6" y="4.9" width="5.6" height="14.2" rx="2.8" fill="#686dfe" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 17v5M9 10.8V4h6v6.8l2 3.2H7z" />
    </svg>
  );
}

function HostsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="14" width="18" height="7" rx="2" />
    </svg>
  );
}

function HostHeader({
  host,
  health,
  count,
  onRetryHost,
  onReenterPassword,
  onOpenHostSettings,
}: {
  host: HostProfile;
  health: HostHealthStatus;
  count: number;
  onRetryHost: (hostId: string) => void;
  onReenterPassword: (hostId: string) => void;
  onOpenHostSettings: (hostId: string) => void;
}) {
  return (
    <div className="drawer-host-header">
      <button
        type="button"
        className="linkish drawer-host-name"
        onClick={() => onOpenHostSettings(host.id)}
      >
        {host.name}
      </button>
      {count > 0 ? <span className="drawer-host-count">{count}</span> : null}
      {health === 'unknown' ? <span className="drawer-host-status">connecting…</span> : null}
      {health === 'reachable' ? <span className="drawer-host-status online">online</span> : null}
      {health === 'unreachable' ? (
        <button type="button" className="linkish" onClick={() => onRetryHost(host.id)}>
          Retry
        </button>
      ) : null}
      {health === 'unauthorized' ? (
        <button type="button" className="linkish danger" onClick={() => onReenterPassword(host.id)}>
          Re-enter password
        </button>
      ) : null}
    </div>
  );
}

function SessionRow({
  host,
  session,
  active,
  label,
  onSelect,
  onRequestKill,
  onRequestRename,
  onSplitFromTab,
}: {
  host: HostProfile;
  session: DrawerSession;
  active: boolean;
  /** Resolved by the parent, which is the only place that can see collisions. */
  label?: string;
  onSelect: (hostId: string, sessionId: string) => void;
  onRequestKill: (hostId: string, sessionId: string, label: string) => void;
  onRequestRename: (hostId: string, sessionId: string, text: string, placeholder: string) => void;
  onSplitFromTab?: (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) => void;
}) {
  const live = active || isRecentlyActive(session.last_output_at);
  const dot = activityDotKey(session.status, session.activity, live);
  const shown = label ?? sessionLabel(session);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // A shell that wants an answer marks its own row even when you are somewhere
  // else — the one thing allowed to pull attention away from the active session.
  const wants = !active && dot === 'waiting';

  return (
    <div
      className={`drawer-session-row${active ? ' active' : ''}${wants ? ' wants' : ''}`}
      draggable={!!onSplitFromTab}
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_DND_MIME, sessionKey(host.id, session.id));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onContextMenu={
        onSplitFromTab
          ? (e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
    >
      {menu && onSplitFromTab && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          onSplit={(dir, side) => onSplitFromTab(host.id, session.id, dir, side)}
          onClose={() => setMenu(null)}
        />
      )}
      <button
        type="button"
        className="drawer-session-main"
        onClick={() => onSelect(host.id, session.id)}
        title={activityLabel(dot)}
      >
        <span className={`activity-dot dot-${dot}`} aria-hidden />
        <span className="drawer-session-title">{shown}</span>
        {session.status === 'stopped' ? <span className="drawer-session-meta">stopped</span> : null}
      </button>
      <button
        type="button"
        className="icon-button"
        title="Rename session"
        onClick={() => onRequestRename(host.id, session.id, session.name ?? shown, shown)}
      >
        ✎
      </button>
      <button
        type="button"
        className="icon-button danger"
        title="Kill session"
        onClick={() => onRequestKill(host.id, session.id, shown)}
      >
        ×
      </button>
    </div>
  );
}

export function SessionDrawer({
  hosts,
  healthByHost,
  sessions,
  activeHostId,
  activeSessionId,
  docked = true,
  showPin = false,
  sidebarPinned = false,
  onTogglePin,
  onSelect,
  onNew,
  onRequestKill,
  onRequestRename,
  onRetryHost,
  onReenterPassword,
  onOpenHosts,
  onOpenSettings,
  onOpenHostSettings,
  onSplitFromTab,
}: SessionDrawerProps) {
  return (
    <aside className={`session-drawer${docked ? ' docked' : ' overlay'}`}>
      <header className="drawer-toolbar">
        <TetherMark />
        <span className="drawer-title">Tether</span>
        <div className="drawer-toolbar-actions">
          {showPin ? (
            <button
              type="button"
              className="icon-button"
              aria-label={sidebarPinned ? 'Unpin sidebar' : 'Pin sidebar'}
              title={sidebarPinned ? 'Unpin sidebar' : 'Pin sidebar'}
              aria-pressed={sidebarPinned}
              onClick={onTogglePin}
            >
              <PinIcon />
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            aria-label="Hosts"
            title="Hosts"
            onClick={onOpenHosts}
          >
            <HostsIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="More actions"
            title="More actions"
            onClick={onOpenSettings}
          >
            ⋯
          </button>
        </div>
      </header>
      <div className="drawer-scroll">
        {hosts.map((host) => {
          const hostSessions = sessions.filter((row) => row.hostId === host.id);
          // Computed per host, because a collision only matters within one list.
          const labels = sessionLabels(hostSessions);
          const health = healthByHost[host.id] ?? 'unknown';
          return (
            <section key={host.id} className="drawer-host-section">
              <HostHeader
                host={host}
                health={health}
                count={hostSessions.length}
                onRetryHost={onRetryHost}
                onReenterPassword={onReenterPassword}
                onOpenHostSettings={onOpenHostSettings}
              />
              {hostSessions.length === 0 ? (
                <p className="muted drawer-empty">No sessions</p>
              ) : (
                hostSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    host={host}
                    session={session}
                    active={host.id === activeHostId && session.id === activeSessionId}
                    label={labels.get(session.id)}
                    onSelect={onSelect}
                    onRequestKill={onRequestKill}
                    onRequestRename={onRequestRename}
                    onSplitFromTab={onSplitFromTab}
                  />
                ))
              )}
              <button
                type="button"
                className="secondary drawer-host-new"
                onClick={() => onNew(host.id)}
              >
                New terminal
              </button>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
