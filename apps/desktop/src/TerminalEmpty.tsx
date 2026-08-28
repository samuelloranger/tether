/**
 * What the screen says when a host has no terminal open.
 *
 * A launch is not allowed to open one for you — the WebSocket open path calls
 * `startSession`, so restoring onto nothing would spawn a shell nobody asked
 * for. So the screen asks instead of guessing.
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
