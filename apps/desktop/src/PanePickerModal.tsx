import { useMemo } from 'react';
import type { SessionRef } from './paneTree';
import { sessionKey } from './sessionKey';
import { sessionLabel, tabLabels } from './sessionLabel';
import type { DrawerSession, HostProfile } from './types';

/**
 * Chooser for an empty pane: pick an existing session (any host) or start a new one.
 * Labels reuse the cross-host tab labelling so collisions stay legible.
 */
export function PanePickerModal({
  hosts,
  sessions,
  onPick,
  onNew,
  onClose,
}: {
  hosts: HostProfile[];
  sessions: DrawerSession[];
  onPick: (ref: SessionRef) => void;
  onNew: (hostId: string) => void;
  onClose: () => void;
}) {
  const labels = useMemo(() => tabLabels(sessions, hosts), [sessions, hosts]);
  const firstHostId = hosts[0]?.id ?? null;

  return (
    <>
      <button
        type="button"
        className="pane-picker-scrim"
        aria-label="Close picker"
        onClick={onClose}
      />
      <div className="pane-picker">
        <div className="pane-picker-title">Choose a session</div>
        <div className="pane-picker-list">
          {sessions.map((session) => {
            const label =
              labels.get(sessionKey(session.hostId, session.id)) ?? sessionLabel(session);
            return (
              <button
                type="button"
                key={sessionKey(session.hostId, session.id)}
                className="pane-picker-item"
                onClick={() => onPick({ hostId: session.hostId, sessionId: session.id })}
              >
                {label}
              </button>
            );
          })}
          {sessions.length === 0 && <div className="pane-picker-empty muted">No sessions yet.</div>}
        </div>
        {firstHostId && (
          <button type="button" className="pane-picker-new" onClick={() => onNew(firstHostId)}>
            + New session
          </button>
        )}
      </div>
    </>
  );
}
