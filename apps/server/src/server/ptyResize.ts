export interface Dims {
  cols: number;
  rows: number;
}

// PTY dims from the network are untrusted: NaN/0/huge values wedge or crash the
// terminal. Clamp to a sane envelope.
export function clampDims(cols: unknown, rows: unknown): Dims {
  const c = Math.floor(Number(cols));
  const r = Math.floor(Number(rows));
  return {
    cols: Number.isFinite(c) ? Math.min(500, Math.max(2, c)) : 80,
    rows: Number.isFinite(r) ? Math.min(200, Math.max(2, r)) : 24,
  };
}

/**
 * Decide the PTY size for a shared session, and whether it is worth telling the
 * holder about.
 *
 * A PTY has one size, so the session is fit to the SMALLEST attached client
 * (tmux model): content fits everyone and a larger client just gets blank
 * margin.
 *
 * Returns `null` when no frame should be sent — either nothing is attached, or
 * the fit lands on the size the PTY already has. That second case is the point:
 * `proc.terminal.resize()` raises SIGWINCH unconditionally, and a full-screen
 * TUI (Claude Code, cursor-agent) answers every SIGWINCH with a complete
 * repaint — tens of KB, logged and broadcast to every client. Reconnecting one
 * session used to fire two of them (detach recompute + attach recompute) at
 * identical dims, so returning from another app repainted every resident tab
 * twice for no reason, interleaving stale-geometry frames with the replay.
 */
/** Kick the PTY (SIGWINCH at current dims) when a viewer looks at the session
 *  again. Skip the first focus-true on a subscriber so reconnect does not
 *  full-repaint every resident tab. */
export function shouldKickPtyOnFocus(args: {
  wasFocused: boolean | undefined;
  sawFocus: boolean;
  focused: boolean;
}): boolean {
  return args.focused && args.sawFocus && args.wasFocused === false;
}

export function planPtyResize(current: Dims | null, clients: Iterable<Dims>): Dims | null {
  let cols = Number.POSITIVE_INFINITY;
  let rows = Number.POSITIVE_INFINITY;
  let any = false;
  for (const d of clients) {
    any = true;
    cols = Math.min(cols, d.cols);
    rows = Math.min(rows, d.rows);
  }
  if (!any) return null;
  const next = clampDims(cols, rows);
  if (current && current.cols === next.cols && current.rows === next.rows) return null;
  return next;
}
