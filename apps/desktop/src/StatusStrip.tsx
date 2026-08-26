import { useEffect, useState } from 'react';
import { activityLabel, type DotKey } from './activity';
import { relativeSince } from './sessionStrip';

interface StatusStripProps {
  sessionId: string;
  /** null when no session is resident — the strip then reports nothing rather than guessing. */
  dot: DotKey | null;
  lastOutputAt: string | null;
}

/**
 * The floor of the screen. Without it the terminal trails off into the chrome;
 * with it the screen reads as a bounded object.
 *
 * It shows the PTY key (which appears nowhere else in the UI and is what every
 * API route is addressed by), how long since output last landed, and the
 * inferred state. Live cwd, shell and geometry are deliberately absent: the
 * Rust core does not forward them, and inventing them here would be worse than
 * omitting them.
 */
export function StatusStrip({ sessionId, dot, lastOutputAt }: StatusStripProps) {
  // The age is the only thing here that moves on its own, so it needs a tick of
  // its own — nothing else re-renders this row.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="status-strip">
      <span className="strip-primary">{sessionId}</span>
      <span>out {relativeSince(lastOutputAt)}</span>
      {dot ? <span className="strip-state">{activityLabel(dot)}</span> : null}
    </div>
  );
}
