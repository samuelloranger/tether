import type { HostHealthStatus } from './hostHealth';
import type { HostProfile } from './hostStore';

const HEALTH_LABEL: Record<HostHealthStatus, string> = {
  unknown: 'Checking…',
  reachable: 'online',
  unreachable: 'Unreachable · retrying',
  unauthorized: 'Needs password',
};

interface HostsScreenProps {
  hosts: HostProfile[];
  healthByHost: Record<string, HostHealthStatus>;
  onBack: () => void;
  onAdd: () => void;
  onEdit: (hostId: string) => void;
  onRemove: (hostId: string) => void;
  onSelect: (hostId: string) => void;
}

export function HostsScreen({
  hosts,
  healthByHost,
  onBack,
  onAdd,
  onEdit,
  onRemove,
  onSelect,
}: HostsScreenProps) {
  return (
    <div className="panel hosts-panel">
      <button type="button" className="linkish back-link" onClick={onBack}>
        ← Sessions
      </button>
      <header className="hosts-header">
        <h1>Hosts</h1>
        <button type="button" onClick={onAdd}>
          Add host
        </button>
      </header>
      <ul className="hosts-list">
        {hosts.map((host) => {
          const health = healthByHost[host.id] ?? 'unknown';
          return (
            <li key={host.id} className="hosts-row">
              <button type="button" className="hosts-row-main" onClick={() => onSelect(host.id)}>
                <span className="hosts-row-name">{host.name}</span>
                <span className="hosts-row-meta">
                  {host.host}:{host.port} · {HEALTH_LABEL[health]}
                </span>
              </button>
              <button type="button" className="secondary small" onClick={() => onEdit(host.id)}>
                Edit
              </button>
              <button
                type="button"
                className="secondary small danger"
                onClick={() => {
                  if (window.confirm(`Remove ${host.name}? Saved credentials will be deleted.`)) {
                    void onRemove(host.id);
                  }
                }}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      {hosts.length === 0 ? <p className="muted">No hosts yet.</p> : null}
    </div>
  );
}
