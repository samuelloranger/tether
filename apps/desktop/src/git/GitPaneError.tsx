/** Failed load: server reason + retry. Replaces empty-state copy, never shares it. */
export function GitPaneError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="git-pane-message">
      <p className="error">{message}</p>
      <button type="button" className="linkish" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
