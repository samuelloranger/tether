/**
 * Shown when a host has no terminal open. A launch must not open one — the WS open
 * path calls `startSession` — so the screen asks instead of spawning a shell.
 */
export function TerminalEmpty(props: { open: boolean; hostName: string; onNew: () => void }) {
  const { hostName, onNew, open } = props;
  if (!open) return null;
  return (
    <div className="empty-main">
      <p>No terminal open on {hostName}.</p>
      <button type="button" onClick={onNew}>
        New terminal
      </button>
    </div>
  );
}
