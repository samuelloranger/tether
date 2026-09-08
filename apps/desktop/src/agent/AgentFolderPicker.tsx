import { useState } from 'react';

/**
 * Choose a working directory for a new agent chat. A path-entry modal — the
 * server resolves and validates the cwd on `agent.start`. (Rich directory
 * browsing, as on iOS, is a follow-up; it needs a session-less fs command.)
 */
export function AgentFolderPicker({
  initialPath = '',
  onPick,
  onCancel,
}: {
  initialPath?: string;
  onPick: (cwd: string) => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const confirm = () => {
    const trimmed = path.trim();
    if (trimmed) onPick(trimmed);
  };

  return (
    <div className="agent-folder-picker">
      <div className="agent-folder-title">New agent chat</div>
      <label className="agent-folder-label" htmlFor="agent-cwd">
        Working directory
      </label>
      <input
        id="agent-cwd"
        className="agent-folder-input"
        type="text"
        placeholder="/path/to/project"
        value={path}
        // biome-ignore lint/a11y/noAutofocus: modal opens for this single input
        autoFocus
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirm();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="agent-folder-actions">
        <button type="button" className="agent-folder-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="agent-folder-confirm"
          onClick={confirm}
          disabled={!path.trim()}
        >
          Start
        </button>
      </div>
    </div>
  );
}
