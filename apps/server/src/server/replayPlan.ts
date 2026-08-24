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
  return planReplayNewest([...logs].reverse(), budget);
}

/** Plans a replay from a newest-to-oldest source and stops reading once full. */
export function planReplayNewest<T extends ReplayChunk>(
  newestFirst: Iterable<T>,
  budget = REPLAY_BYTE_BUDGET,
): ReplayPlan<T> {
  let bytes = 0;
  let reset = false;
  const logs: T[] = [];
  for (const log of newestFirst) {
    const size = Buffer.byteLength(log.chunk);
    // The first row is the newest: take it unconditionally, even if oversized.
    if (logs.length > 0 && bytes + size > budget) {
      reset = true;
      break;
    }
    logs.push(log);
    bytes += size;
  }
  logs.reverse();
  return { reset, logs, bytes };
}

export interface ReplayOutputFrame {
  type: 'output';
  id: number;
  chunk: string;
}

/** Coalesces replay rows while preserving the final acknowledged log id. */
export function replayOutputFrames<T extends ReplayChunk & { id: number }>(
  logs: T[],
  rowsPerFrame = 200,
): ReplayOutputFrame[] {
  const frames: ReplayOutputFrame[] = [];
  for (let start = 0; start < logs.length; start += rowsPerFrame) {
    const batch = logs.slice(start, start + rowsPerFrame);
    frames.push({
      type: 'output',
      id: batch[batch.length - 1].id,
      chunk: batch.map((log) => log.chunk).join(''),
    });
  }
  return frames;
}
