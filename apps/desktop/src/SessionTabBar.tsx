import { useMemo, useState } from 'react';
import { activityDotKey, activityLabel, type DotKey } from './activity';
import { isRecentlyActive } from './desktopNavigation';
import type { PaneDir, PaneSide } from './paneTree';
import { parseSessionKey, sessionKey } from './sessionKey';
import { sessionLabel, tabLabels } from './sessionLabel';
import { TabContextMenu } from './TabContextMenu';
import { TerminalToolbar } from './TerminalToolbar';
import type { DrawerSession, HostHealthStatus, HostProfile } from './types';
import type { BeginTabDrag } from './useTabDrag';
import type { TetherDesktop } from './useTetherDesktop';
import {
  aggregateDot,
  groupHostIds,
  groupLabel,
  isGroup,
  type View,
  viewMemberKeys,
} from './viewModel';

interface SessionTabBarProps {
  hosts: HostProfile[];
  healthByHost: Record<string, HostHealthStatus>;
  sessions: DrawerSession[];
  views: View[];
  activeViewId: string;
  activeHostId: string | null;
  onSelectView: (viewId: string) => void;
  onNew: (hostId: string) => void;
  onRequestKill: (hostId: string, sessionId: string, label: string) => void;
  onRequestKillMembers: (
    members: Array<{ hostId: string; sessionId: string }>,
    label: string,
  ) => void;
  onOpenHosts: () => void;
  onSplitFromTab?: (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) => void;
  onBeginDrag?: BeginTabDrag;
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
  onBeginDrag,
}: {
  host: HostProfile;
  session: DrawerSession;
  active: boolean;
  label: string;
  dimmed: boolean;
  onSelect: () => void;
  onRequestKill: (hostId: string, sessionId: string, label: string) => void;
  onSplitFromTab?: (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) => void;
  onBeginDrag?: BeginTabDrag;
}) {
  const live = active || isRecentlyActive(session.last_output_at);
  const dot = activityDotKey(session.status, session.activity, live);
  const wants = !active && dot === 'waiting';
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only tab drag + right-click split; the tab's actions live in the buttons inside
    <div
      className={`session-tab${active ? ' active' : ''}${wants ? ' wants' : ''}${dimmed ? ' dimmed' : ''}`}
      onPointerDown={(e) => onBeginDrag?.(e, host.id, session.id, label)}
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
        onClick={onSelect}
      >
        <span className={`activity-dot dot-${dot}`} aria-hidden />
        <span className="session-tab-title">{label}</span>
      </button>
      <button
        type="button"
        className="icon-button session-tab-kill"
        title="Kill session"
        aria-label={`Kill ${label}`}
        data-tab-action
        onClick={() => onRequestKill(host.id, session.id, label)}
      >
        ×
      </button>
    </div>
  );
}

function GroupTab({
  view,
  hosts,
  sessions,
  healthByHost,
  active,
  label,
  onSelect,
  onRequestKillMembers,
}: {
  view: View;
  hosts: HostProfile[];
  sessions: DrawerSession[];
  healthByHost: Record<string, HostHealthStatus>;
  active: boolean;
  label: string;
  onSelect: () => void;
  onRequestKillMembers: (
    members: Array<{ hostId: string; sessionId: string }>,
    label: string,
  ) => void;
}) {
  const dot = aggregateDot(view, sessions);
  const wants = !active && dot === 'waiting';
  const colors = groupHostIds(view).flatMap((id) => {
    const host = hosts.find((h) => h.id === id);
    return host ? [{ id, color: host.color }] : [];
  });
  const dimmed = groupHostIds(view).every((id) => {
    const health = healthByHost[id] ?? 'unknown';
    return health === 'unreachable' || health === 'unauthorized';
  });
  const members = viewMemberKeys(view).map(parseSessionKey);

  return (
    <div
      className={`session-tab session-tab-group${active ? ' active' : ''}${wants ? ' wants' : ''}${dimmed ? ' dimmed' : ''}`}
    >
      <span className="session-tab-hosts" aria-hidden>
        {colors.map((chip) => (
          <span
            key={chip.id}
            className="session-tab-host-chip"
            style={{ background: chip.color }}
          />
        ))}
      </span>
      <button
        type="button"
        className="session-tab-main"
        role="tab"
        aria-selected={active}
        title={activityLabel(dot)}
        onClick={onSelect}
      >
        <span className={`activity-dot dot-${dot}`} aria-hidden />
        <span className="session-tab-title">{label}</span>
      </button>
      <button
        type="button"
        className="icon-button session-tab-kill"
        title="Kill sessions"
        aria-label={`Kill ${label}`}
        data-tab-action
        onClick={() => onRequestKillMembers(members, label)}
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
  views,
  activeViewId,
  activeHostId,
  onSelectView,
  onNew,
  onRequestKill,
  onRequestKillMembers,
  onOpenHosts,
  onSplitFromTab,
  onBeginDrag,
}: SessionTabBarProps) {
  const labels = useMemo(() => tabLabels(sessions, hosts), [sessions, hosts]);

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
        {views.map((view) => {
          if (isGroup(view)) {
            return (
              <GroupTab
                key={view.id}
                view={view}
                hosts={hosts}
                sessions={sessions}
                healthByHost={healthByHost}
                active={view.id === activeViewId}
                label={groupLabel(view, sessions, hosts)}
                onSelect={() => onSelectView(view.id)}
                onRequestKillMembers={onRequestKillMembers}
              />
            );
          }
          const ref = view.tree.kind === 'leaf' ? view.tree.session : null;
          if (!ref) return null;
          const host = hosts.find((h) => h.id === ref.hostId);
          const session = sessions.find(
            (row) => row.hostId === ref.hostId && row.id === ref.sessionId,
          );
          if (!host || !session) return null;
          const shown = labels.get(sessionKey(host.id, session.id)) ?? sessionLabel(session);
          const health = healthByHost[host.id] ?? 'unknown';
          return (
            <SessionTab
              key={view.id}
              host={host}
              session={session}
              active={view.id === activeViewId}
              label={shown}
              dimmed={health === 'unreachable' || health === 'unauthorized'}
              onSelect={() => onSelectView(view.id)}
              onRequestKill={onRequestKill}
              onSplitFromTab={onSplitFromTab}
              onBeginDrag={onBeginDrag}
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
  views,
  activeViewId,
  dot,
  hasSession,
  onNew,
  onKill,
  onKillMembers,
  onWorkspace,
  onUpload,
  onOverflow,
  onSplitFromTab,
  onSelectView,
  onBeginDrag,
}: {
  showTabBar: boolean;
  inset: boolean;
  app: TetherDesktop;
  views: View[];
  activeViewId: string;
  dot: DotKey | null;
  hasSession: boolean;
  onNew: (hostId: string) => void;
  onKill: (hostId: string, sessionId: string, label: string) => void;
  onKillMembers: (members: Array<{ hostId: string; sessionId: string }>, label: string) => void;
  onWorkspace: () => void;
  onUpload: () => void;
  onOverflow: () => void;
  onSplitFromTab?: (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) => void;
  onSelectView: (viewId: string) => void;
  onBeginDrag?: BeginTabDrag;
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
          views={views}
          activeViewId={activeViewId}
          activeHostId={app.activeHostId}
          onSelectView={onSelectView}
          onNew={onNew}
          onRequestKill={onKill}
          onRequestKillMembers={onKillMembers}
          onOpenHosts={() => app.setScreen('hosts')}
          onSplitFromTab={onSplitFromTab}
          onBeginDrag={onBeginDrag}
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
