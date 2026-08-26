import { useState } from 'react';
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
  onSelect: (hostId: string, sessionId: string) => void;
  onNew: () => void;
  onKill: (hostId: string, sessionId: string) => void;
  onRename: (hostId: string, sessionId: string, name: string) => void;
  onRetryHost: (hostId: string) => void;
  onReenterPassword: (hostId: string) => void;
  onOpenHosts: () => void;
  onOpenSettings: () => void;
}

function HostHeader({
  host,
  health,
  onRetryHost,
  onReenterPassword,
}: {
  host: HostProfile;
  health: HostHealthStatus;
  onRetryHost: (hostId: string) => void;
  onReenterPassword: (hostId: string) => void;
}) {
  return (
    <div className="drawer-host-header">
      <span className="drawer-host-name">{host.name}</span>
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
  onKill,
  onRename,
}: {
  host: HostProfile;
  session: DrawerSession;
  active: boolean;
  onSelect: (hostId: string, sessionId: string) => void;
  onKill: (hostId: string, sessionId: string) => void;
  onRename: (hostId: string, sessionId: string, name: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState(session.name ?? '');
  const live = active || isRecentlyActive(session.last_output_at);
  const dot = activityDotKey(session.status, session.activity, live);

  const submitRename = () => {
    setRenaming(false);
    void onRename(host.id, session.id, renameText.trim());
  };

  return (
    <div className={`drawer-session-row${active ? ' active' : ''}`}>
      <button
        type="button"
        className="drawer-session-main"
        onClick={() => onSelect(host.id, session.id)}
        title={activityLabel(dot)}
      >
        <span className={`activity-dot dot-${dot}`} aria-hidden />
        {renaming ? (
          <input
            className="rename-input"
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={submitRename}
          />
        ) : (
          <span className="drawer-session-title">{sessionLabel(session)}</span>
        )}
        {session.status === 'stopped' ? <span className="drawer-session-meta">stopped</span> : null}
      </button>
      <button
        type="button"
        className="icon-button"
        title="Rename session"
        onClick={() => {
          setRenameText(session.name ?? sessionLabel(session));
          setRenaming(true);
        }}
      >
        ✎
      </button>
      <button
        type="button"
        className="icon-button danger"
        title="Kill session"
        onClick={() => {
          if (window.confirm('Kill this terminal? The process and saved output will be deleted.')) {
            void onKill(host.id, session.id);
          }
        }}
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
  onSelect,
  onNew,
  onKill,
  onRename,
  onRetryHost,
  onReenterPassword,
  onOpenHosts,
  onOpenSettings,
}: SessionDrawerProps) {
  return (
    <aside className="session-drawer">
      <header className="drawer-toolbar">
        <strong>Sessions</strong>
        <div className="drawer-toolbar-actions">
          <button type="button" className="secondary small" onClick={onOpenSettings}>
            Settings
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
                    onKill={onKill}
                    onRename={onRename}
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
