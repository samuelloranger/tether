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

export interface ReplayOutputFrame {
  type: 'output';
  id: number;
  chunk: string;
}

export interface ReplayRowSize {
  id: number;
  bytes: number;
}

export interface ReplaySelection {
  reset: boolean;
  oldestId: number | null;
  newestId: number | null;
  count: number;
  bytes: number;
}

/** Selects a byte-bounded newest suffix from rows that contain no chunk data. */
export function selectReplayNewest(
  newestFirst: Iterable<ReplayRowSize>,
  budget = REPLAY_BYTE_BUDGET,
): ReplaySelection {
  let bytes = 0;
  let count = 0;
  let oldestId: number | null = null;
  let newestId: number | null = null;
  let reset = false;
  for (const row of newestFirst) {
    if (count > 0 && bytes + row.bytes > budget) {
      reset = true;
      break;
    }
    if (newestId === null) newestId = row.id;
    oldestId = row.id;
    count++;
    bytes += row.bytes;
  }
  return { reset, oldestId, newestId, count, bytes };
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
