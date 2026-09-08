/** A shell prompt glyph — marks a terminal (pty) session. */
function TerminalIcon() {
  return (
    <svg
      className="session-kind-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 8l4 4-4 4M13 16h6" />
    </svg>
  );
}

/** A chat bubble — marks an agent chat session. */
function AgentIcon() {
  return (
    <svg
      className="session-kind-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 13a2 2 0 0 1-2 2H9l-4 4V6a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Leading icon distinguishing an agent chat from a terminal, matching iOS. */
export function SessionKindIcon({ kind }: { kind?: string | null }) {
  return kind === 'agent' ? <AgentIcon /> : <TerminalIcon />;
}
