import { useCallback, useEffect, useState } from 'react';
import { createHostClient, fetchSessions, type HostConfig, type TetherSession } from './hostClient';

interface SessionListScreenProps {
  config: HostConfig;
  onOpenSession: (sessionId: string) => void;
  onDisconnect: () => void;
}

function sessionLabel(row: TetherSession): string {
  return row.auto_title || row.name || row.id;
}

export function SessionListScreen({ config, onOpenSession, onDisconnect }: SessionListScreenProps) {
  const [sessions, setSessions] = useState<TetherSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const client = createHostClient(config);
      setSessions(await fetchSessions(client));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load sessions.');
    } finally {
      setBusy(false);
    }
  }, [config]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="panel session-panel">
      <header className="session-header">
        <div>
          <h1>Sessions</h1>
          <p className="muted">
            {config.host}:{config.port}
          </p>
        </div>
        <div className="session-actions">
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          <button type="button" className="secondary" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {busy && sessions.length === 0 ? <p className="muted">Loading…</p> : null}
      <ul className="session-list">
        {sessions.map((row) => (
          <li key={row.id}>
            <button type="button" className="session-row" onClick={() => onOpenSession(row.id)}>
              <span className="session-title">{sessionLabel(row)}</span>
              <span className={`session-status status-${row.status}`}>{row.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
