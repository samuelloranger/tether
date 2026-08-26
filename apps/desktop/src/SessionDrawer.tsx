import { activityDotKey, activityLabel } from './activity';
import { isRecentlyActive } from './desktopNavigation';
import { sessionLabel } from './sessionLabel';
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
  onNew: () => void;
  onRequestKill: (hostId: string, sessionId: string, label: string) => void;
  onRequestRename: (hostId: string, sessionId: string, text: string, placeholder: string) => void;
  onRetryHost: (hostId: string) => void;
  onReenterPassword: (hostId: string) => void;
  onOpenHosts: () => void;
  onOpenSettings: () => void;
  onOpenHostSettings: (hostId: string) => void;
  onOpenLocalSettings: () => void;
}

function HostHeader({
  host,
  health,
  onRetryHost,
  onReenterPassword,
  onOpenHostSettings,
}: {
  host: HostProfile;
  health: HostHealthStatus;
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
  onSelect,
  onRequestKill,
  onRequestRename,
}: {
  host: HostProfile;
  session: DrawerSession;
  active: boolean;
  onSelect: (hostId: string, sessionId: string) => void;
  onRequestKill: (hostId: string, sessionId: string, label: string) => void;
  onRequestRename: (hostId: string, sessionId: string, text: string, placeholder: string) => void;
}) {
  const live = active || isRecentlyActive(session.last_output_at);
  const dot = activityDotKey(session.status, session.activity, live);
  const label = sessionLabel(session);

  return (
    <div className={`drawer-session-row${active ? ' active' : ''}`}>
      <button
        type="button"
        className="drawer-session-main"
        onClick={() => onSelect(host.id, session.id)}
        title={activityLabel(dot)}
      >
        <span className={`activity-dot dot-${dot}`} aria-hidden />
        <span className="drawer-session-title">{label}</span>
        {session.status === 'stopped' ? <span className="drawer-session-meta">stopped</span> : null}
      </button>
      <button
        type="button"
        className="icon-button"
        title="Rename session"
        onClick={() => onRequestRename(host.id, session.id, session.name ?? label, label)}
      >
        ✎
      </button>
      <button
        type="button"
        className="icon-button danger"
        title="Kill session"
        onClick={() => onRequestKill(host.id, session.id, label)}
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
  onOpenLocalSettings,
}: SessionDrawerProps) {
  return (
    <aside className={`session-drawer${docked ? ' docked' : ' overlay'}`}>
      <header className="drawer-toolbar">
        <strong>Sessions</strong>
        <div className="drawer-toolbar-actions">
          {showPin ? (
            <button
              type="button"
              className="secondary small"
              title={sidebarPinned ? 'Unpin sidebar' : 'Pin sidebar'}
              onClick={onTogglePin}
            >
              {sidebarPinned ? 'Unpin' : 'Pin'}
            </button>
          ) : null}
          <button type="button" className="secondary small" onClick={onOpenLocalSettings}>
            App
          </button>
          <button type="button" className="secondary small" onClick={onOpenSettings}>
            ⋯
          </button>
          <button type="button" className="secondary small" onClick={onOpenHosts}>
            Hosts
          </button>
        </div>
      </header>
      <div className="drawer-scroll">
        {hosts.map((host) => {
          const hostSessions = sessions.filter((row) => row.hostId === host.id);
          const health = healthByHost[host.id] ?? 'unknown';
          return (
            <section key={host.id} className="drawer-host-section">
              <HostHeader
                host={host}
                health={health}
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
                    onSelect={onSelect}
                    onRequestKill={onRequestKill}
                    onRequestRename={onRequestRename}
                  />
                ))
              )}
            </section>
          );
        })}
      </div>
      <footer className="drawer-footer">
        <button type="button" onClick={onNew} disabled={!activeHostId}>
          + New session
        </button>
      </footer>
    </aside>
  );
}
