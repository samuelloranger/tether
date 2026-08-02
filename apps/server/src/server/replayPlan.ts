/**
 * Bounds WebSocket catch-up replay by BYTES, not row count.
 *
 * A single PTY frame can be hundreds of KB (a full-screen repaint from a TUI),
 * so a row-capped scrollback is not a size cap: 2000 rows once reached 91 MB in
 * practice. Blasting that at a reconnecting client kills it mid-replay, and it
 * comes back with a barely-advanced sinceId — so the next replay is *larger*.
 * That feedback loop is a death spiral; capping the replay breaks it.
 *
 * Over budget we keep only the newest rows that fit and tell the caller to send
 * a `reset` first, exactly like the pruned-history path: the client wipes its
 * emulator and renders a coherent recent tail instead of a hole.
 */

/** Max bytes of scrollback streamed to a reconnecting client in one catch-up. */
export const REPLAY_BYTE_BUDGET = 2_000_000;

export interface ReplayChunk {
  chunk: string;
}

export interface ReplayPlan<T> {
  /** True when older rows were dropped, so the client must reset before replay. */
  reset: boolean;
  logs: T[];
  bytes: number;
}

/**
 * Trims `logs` (oldest → newest) to the newest suffix fitting `budget` bytes.
 * The newest row is always kept, even if it alone exceeds the budget — sending
 * a truncated tail beats sending nothing.
 */
export function planReplay<T extends ReplayChunk>(
  logs: T[],
  budget = REPLAY_BYTE_BUDGET,
): ReplayPlan<T> {
  let bytes = 0;
  let start = logs.length;
  while (start > 0) {
    const size = logs[start - 1].chunk.length;
    // `start === logs.length` is the newest row: take it unconditionally.
    if (start < logs.length && bytes + size > budget) break;
    bytes += size;
    start--;
    if (bytes >= budget) break;
  }
  return { reset: start > 0, logs: logs.slice(start), bytes };
}
