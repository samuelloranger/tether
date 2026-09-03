import { useMemo, useState } from 'react';
import { activityDotKey, activityLabel, type DotKey } from './activity';
import { isRecentlyActive } from './desktopNavigation';
import { SESSION_DND_MIME } from './dropZone';
import type { PaneDir, PaneSide } from './paneTree';
import { sessionKey } from './sessionKey';
import { sessionLabel, tabLabels } from './sessionLabel';
import { TabContextMenu } from './TabContextMenu';
import { TerminalToolbar } from './TerminalToolbar';
import type { DrawerSession, HostHealthStatus, HostProfile } from './types';
import type { TetherDesktop } from './useTetherDesktop';

interface SessionTabBarProps {
  hosts: HostProfile[];
  healthByHost: Record<string, HostHealthStatus>;
  sessions: DrawerSession[];
  activeHostId: string | null;
  activeSessionId: string;
  onSelect: (hostId: string, sessionId: string) => void;
  onNew: (hostId: string) => void;
  onRequestKill: (hostId: string, sessionId: string, label: string) => void;
  onOpenHosts: () => void;
  onSplitFromTab?: (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) => void;
}

function HostsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="14" width="18" height="7" rx="2" />
    </svg>
  );
}

function SessionTab({
  host,
  session,
  active,
  label,
  dimmed,
  onSelect,
  onRequestKill,
  onSplitFromTab,
}: {
  host: HostProfile;
  session: DrawerSession;
  active: boolean;
  label: string;
  dimmed: boolean;
  onSelect: (hostId: string, sessionId: string) => void;
  onRequestKill: (hostId: string, sessionId: string, label: string) => void;
  onSplitFromTab?: (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) => void;
}) {
  const live = active || isRecentlyActive(session.last_output_at);
  const dot = activityDotKey(session.status, session.activity, live);
  const wants = !active && dot === 'waiting';
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only tab drag + right-click split; the tab's actions live in the buttons inside
    <div
      className={`session-tab${active ? ' active' : ''}${wants ? ' wants' : ''}${dimmed ? ' dimmed' : ''}`}
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
      <span className="session-tab-host" style={{ background: host.color }} aria-hidden />
      <button
        type="button"
        className="session-tab-main"
        role="tab"
        aria-selected={active}
        title={activityLabel(dot)}
        onClick={() => onSelect(host.id, session.id)}
      >
        <span className={`activity-dot dot-${dot}`} aria-hidden />
        <span className="session-tab-title">{label}</span>
      </button>
      <button
        type="button"
        className="icon-button session-tab-kill"
        title="Kill session"
        aria-label={`Kill ${label}`}
        onClick={() => onRequestKill(host.id, session.id, label)}
      >
        ×
      </button>
    </div>
  );
}

export function SessionTabBar({
  hosts,
  healthByHost,
  sessions,
  activeHostId,
  activeSessionId,
  onSelect,
  onNew,
  onRequestKill,
  onOpenHosts,
  onSplitFromTab,
}: SessionTabBarProps) {
  const labels = useMemo(() => tabLabels(sessions, hosts), [sessions, hosts]);
  const ordered = hosts.flatMap((host) =>
    sessions.filter((row) => row.hostId === host.id).map((session) => ({ host, session })),
  );

  return (
    <div className="session-tabbar">
      <button
        type="button"
        className="icon-button"
        aria-label="Hosts"
        title="Hosts"
        onClick={onOpenHosts}
      >
        <HostsIcon />
      </button>
      <div className="session-tabs" role="tablist">
        {ordered.map(({ host, session }) => {
          const health = healthByHost[host.id] ?? 'unknown';
          const shown = labels.get(sessionKey(host.id, session.id)) ?? sessionLabel(session);
          return (
            <SessionTab
              key={sessionKey(host.id, session.id)}
              host={host}
              session={session}
              active={host.id === activeHostId && session.id === activeSessionId}
              label={shown}
              dimmed={health === 'unreachable' || health === 'unauthorized'}
              onSelect={onSelect}
              onRequestKill={onRequestKill}
              onSplitFromTab={onSplitFromTab}
            />
          );
        })}
      </div>
      <button
        type="button"
        className="session-tab-new"
        aria-label="New terminal"
        title="New terminal"
        disabled={!activeHostId}
        onClick={() => {
          if (activeHostId) onNew(activeHostId);
        }}
      >
        +
      </button>
    </div>
  );
}

/** Tab strip (when horizontal) plus the session toolbar. */
export function SessionChrome({
  showTabBar,
  inset,
  app,
  dot,
  hasSession,
  onNew,
  onKill,
  onWorkspace,
  onUpload,
  onOverflow,
  onSplitFromTab,
  onSelectSession,
}: {
  showTabBar: boolean;
  inset: boolean;
  app: TetherDesktop;
  dot: DotKey | null;
  hasSession: boolean;
  onNew: (hostId: string) => void;
  onKill: (hostId: string, sessionId: string, label: string) => void;
  onWorkspace: () => void;
  onUpload: () => void;
  onOverflow: () => void;
  onSplitFromTab?: (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) => void;
  onSelectSession?: (hostId: string, sessionId: string) => void;
}) {
  const host = app.activeHost;
  if (!host) return null;
  return (
    <>
      {showTabBar ? (
        <SessionTabBar
          hosts={app.hosts}
          healthByHost={app.healthByHost}
          sessions={app.sessions}
          activeHostId={app.activeHostId}
          activeSessionId={app.activeSessionId}
          onSelect={onSelectSession ?? app.selectSession}
          onNew={onNew}
          onRequestKill={onKill}
          onOpenHosts={() => app.setScreen('hosts')}
          onSplitFromTab={onSplitFromTab}
        />
      ) : null}
      <TerminalToolbar
        sessionLabel={app.activeSessionLabel}
        dot={dot}
        address={`${host.host}:${host.port}`}
        hasSession={hasSession}
        inset={inset}
        showSessionLabel={!showTabBar}
        onGit={() => {
          app.setGitMode('drawer');
          app.setGitOpen(true);
        }}
        onReview={() => {
          app.setGitMode('review');
          app.setGitOpen(true);
        }}
        onWorkspace={onWorkspace}
        onUpload={onUpload}
        onOverflow={onOverflow}
      />
    </>
  );
}
