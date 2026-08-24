/**
 * Reads a byte-bounded replay window out of `terminal_logs`.
 *
 * Split from db.ts because this is the one read path that must not materialize
 * the whole retained scrollback: see replayPlan.ts for why an unbounded catch-up
 * is a death spiral.
 */
import { db, getLogs, retainedBytes, type TerminalLog } from './db';
import { type ReplayPlan, selectReplayNewest } from './replayPlan';

/**
 * Yields `{id, bytes}` newest-first in pages, so a caller that fills its budget
 * early stops before touching older rows — and never loads `chunk` to do it.
 */
function* getLogSizesNewest(
  sessionId: string,
  sinceId: number,
  batchSize = 200,
): Generator<{ id: number; bytes: number }> {
  let beforeId = Number.MAX_SAFE_INTEGER;
  while (true) {
    const rows = db
      .query(
        `SELECT id, octet_length(chunk) AS bytes
         FROM terminal_logs
         WHERE session_id = $sessionId AND id > $sinceId AND id < $beforeId
         ORDER BY id DESC LIMIT $limit`,
      )
      .all({
        $sessionId: sessionId,
        $sinceId: sinceId,
        $beforeId: beforeId,
        $limit: batchSize,
      }) as { id: number; bytes: number }[];
    if (rows.length === 0) return;
    yield* rows;
    beforeId = rows[rows.length - 1].id;
  }
}

/** Selects replay rows by byte metadata, then fetches only the chosen suffix. */
export function getReplayLogs(
  sessionId: string,
  sinceId: number,
  budget: number,
): ReplayPlan<TerminalLog> {
  // The retained tail is an upper bound on what any replay of this session can
  // return, so when the whole thing fits the budget the metadata pass cannot
  // trim anything — skip it. That is the overwhelmingly common case (a reconnect
  // is usually a handful of rows behind; only ~0.6% of replays observed in
  // practice hit the budget), and the two-query path costs ~2x there.
  if (retainedBytes(sessionId) <= budget) {
    const logs = getLogs(sessionId, sinceId);
    let bytes = 0;
    for (const log of logs) bytes += Buffer.byteLength(log.chunk);
    return { reset: false, logs, bytes };
  }

  const selection = selectReplayNewest(getLogSizesNewest(sessionId, sinceId), budget);
  if (selection.oldestId === null || selection.newestId === null) {
    return { reset: false, logs: [], bytes: 0 };
  }
  const logs = db
    .query(
      `SELECT id, session_id, chunk, created_at
       FROM terminal_logs
       WHERE session_id = $sessionId AND id >= $oldestId AND id <= $newestId
       ORDER BY id ASC`,
    )
    .all({
      $sessionId: sessionId,
      $oldestId: selection.oldestId,
      $newestId: selection.newestId,
    }) as TerminalLog[];
  return { reset: selection.reset, logs, bytes: selection.bytes };
}
