import type { ClaudeSessionMeta } from './agentTypes';

function relativeTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** `/resume` browser: past Claude sessions for this project. Picking one opens a
 * new agent tab resumed at that session (history + live context). */
export function AgentResumePicker({
  sessions,
  cwd,
  onPick,
  onClose,
}: {
  sessions: ClaudeSessionMeta[];
  cwd?: string;
  onPick: (session: ClaudeSessionMeta) => void;
  onClose: () => void;
}) {
  return (
    <div className="agent-folder-backdrop" onPointerDown={onClose}>
      <div className="agent-resume-picker" onPointerDown={(e) => e.stopPropagation()}>
        <div className="agent-resume-title">Resume a past session</div>
        {sessions.length === 0 ? (
          <div className="agent-resume-empty">No past sessions for this folder.</div>
        ) : (
          sessions.map((s) => (
            <button type="button" key={s.id} className="agent-resume-row" onClick={() => onPick(s)}>
              <span className="agent-resume-label">{s.label || s.id}</span>
              <span className="agent-resume-when">{relativeTime(s.mtimeMs)}</span>
              <span className="agent-resume-sub">
                {s.msgCount} msgs
                {cwd && s.cwd !== cwd ? <span className="agent-resume-altcwd"> ⌂ {s.cwd}</span> : null}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
