import { canCommit } from './gitApi';

type CommitBoxProps = {
  message: string;
  onChangeMessage: (value: string) => void;
  onCommit: () => void;
  onAmend?: () => void;
  onUndoCommit?: () => void;
  onPush?: () => void;
  canAmend?: boolean;
  canPush?: boolean;
  stagedCount: number;
  committing: boolean;
};

export function CommitBox({
  message,
  onChangeMessage,
  onCommit,
  onAmend,
  onUndoCommit,
  onPush,
  canAmend,
  canPush,
  stagedCount,
  committing,
}: CommitBoxProps) {
  const enabled = canCommit(stagedCount, message, committing);
  const amendEnabled = Boolean(canAmend) && message.trim().length > 0 && !committing;
  const undoEnabled = Boolean(canAmend) && !committing;
  const pushEnabled = Boolean(canPush) && !committing;

  return (
    <div className="git-commit-box">
      <textarea
        className="git-commit-input"
        aria-label="Commit message"
        placeholder="Commit message"
        value={message}
        onChange={(event) => onChangeMessage(event.target.value)}
        disabled={committing}
        rows={2}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <div className="git-commit-actions">
        <button type="button" disabled={!enabled} onClick={onCommit}>
          {committing ? '…' : 'Commit'}
        </button>
        {onAmend ? (
          <button
            type="button"
            className="secondary small"
            disabled={!amendEnabled}
            onClick={onAmend}
          >
            Amend
          </button>
        ) : null}
        {onUndoCommit ? (
          <button
            type="button"
            className="secondary small"
            disabled={!undoEnabled}
            onClick={onUndoCommit}
          >
            Undo
          </button>
        ) : null}
        {onPush ? (
          <button
            type="button"
            className="secondary small"
            disabled={!pushEnabled}
            onClick={onPush}
          >
            Push
          </button>
        ) : null}
      </div>
    </div>
  );
}
