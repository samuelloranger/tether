import { activityLabel, type DotKey } from './activity';

interface TerminalToolbarProps {
  sessionLabel: string;
  /** null when nothing is running — the state chip is then omitted, not faked. */
  dot: DotKey | null;
  address: string;
  /** Every action here addresses a session; with none open they have no target. */
  hasSession: boolean;
  /** Narrow windows put a fixed hamburger over this row, which has to be cleared. */
  inset: boolean;
  onGit: () => void;
  onReview: () => void;
  onWorkspace: () => void;
  onUpload: () => void;
  onOverflow: () => void;
}

/**
 * Session identity on the left, one segmented control on the right.
 *
 * The four actions used to be four separate outlined buttons floating in the
 * row, which read as four unrelated decisions. Grouping them says what is true:
 * they are one set of things you can do to the session named beside them.
 */
export function TerminalToolbar({
  sessionLabel,
  dot,
  address,
  hasSession,
  inset,
  onGit,
  onReview,
  onWorkspace,
  onUpload,
  onOverflow,
}: TerminalToolbarProps) {
  return (
    <header className={`terminal-toolbar${inset ? ' with-menu' : ''}`}>
      <span className="terminal-label">{sessionLabel}</span>
      {dot ? <span className="session-state">{activityLabel(dot)}</span> : null}
      <div className="toolbar-actions">
        <button type="button" onClick={onGit} disabled={!hasSession}>
          Git
        </button>
        <button type="button" onClick={onReview} disabled={!hasSession}>
          Review
        </button>
        <button type="button" onClick={onWorkspace} disabled={!hasSession}>
          Workspace
        </button>
        <button type="button" onClick={onUpload} disabled={!hasSession}>
          Upload
        </button>
      </div>
      <span className="terminal-host-label">{address}</span>
      <button type="button" className="icon-button" aria-label="More actions" onClick={onOverflow}>
        ⋯
      </button>
    </header>
  );
}
