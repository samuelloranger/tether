import type { Database } from 'bun:sqlite';
import { db } from './db';

/**
 * Persisted agent-chat transcript rows. One row per emitted frame, keyed by
 * the same monotonic `seq` the live fan-out already assigns (agentEventMap.ts)
 * — so replay (seq > sinceSeq) and live frames never collide. Deltas are
 * coalesced by the registry before insert (agentRegistry.ts), so this stays
 * low-volume unlike terminal_logs.
 */
export interface AgentMessageRow {
  session_id: string;
  seq: number;
  kind: 'user' | 'delta' | 'tool' | 'tool_result' | 'done' | 'error';
  text: string | null;
  tool_json: string | null;
  is_error: number;
  ts: number;
}

export interface AgentMessageInsert {
  sessionId: string;
  seq: number;
  kind: 'user' | 'delta' | 'tool' | 'tool_result' | 'done' | 'error';
  text?: string | null;
  toolJson?: string | null;
  isError?: boolean;
}

/** Rows kept per agent session — deltas are coalesced, so this stays low-volume. */
const AGENT_MESSAGE_CAP = 4000;
const agentMessageInsertCounts = new Map<string, number>();

export function appendAgentMessage(dbHandle: Database, msg: AgentMessageInsert): void {
  dbHandle
    .query(`
      INSERT INTO agent_messages (session_id, seq, kind, text, tool_json, is_error, ts)
      VALUES ($sessionId, $seq, $kind, $text, $toolJson, $isError, $ts)
      ON CONFLICT(session_id, seq) DO UPDATE SET
        kind = excluded.kind, text = excluded.text, tool_json = excluded.tool_json,
        is_error = excluded.is_error, ts = excluded.ts
    `)
    .run({
      $sessionId: msg.sessionId,
      $seq: msg.seq,
      $kind: msg.kind,
      $text: msg.text ?? null,
      $toolJson: msg.toolJson ?? null,
      $isError: msg.isError ? 1 : 0,
      $ts: Date.now(),
    });
  const n = (agentMessageInsertCounts.get(msg.sessionId) ?? 0) + 1;
  agentMessageInsertCounts.set(msg.sessionId, n);
  if (n % 200 === 0) pruneAgentMessages(dbHandle, msg.sessionId);
}

export function getAgentMessages(
  dbHandle: Database,
  sessionId: string,
  sinceSeq = 0,
): AgentMessageRow[] {
  return dbHandle
    .query(`
      SELECT session_id, seq, kind, text, tool_json, is_error, ts
      FROM agent_messages
      WHERE session_id = $sessionId AND seq > $sinceSeq
      ORDER BY seq ASC
    `)
    .all({ $sessionId: sessionId, $sinceSeq: sinceSeq }) as AgentMessageRow[];
}

/** Highest seq persisted for a session (0 if none) — seeds the live FrameSeq on
 * (re)start so numbering continues monotonically instead of resetting. */
export function maxAgentSeq(dbHandle: Database, sessionId: string): number {
  const row = dbHandle
    .query('SELECT COALESCE(MAX(seq), 0) AS m FROM agent_messages WHERE session_id = $sessionId')
    .get({ $sessionId: sessionId }) as { m: number } | null;
  return row?.m ?? 0;
}

/** Purge one session's transcript — called from the agent kill route alongside deleteSession. */
export function deleteAgentMessages(sessionId: string): void {
  db.query('DELETE FROM agent_messages WHERE session_id = $sessionId').run({
    $sessionId: sessionId,
  });
  agentMessageInsertCounts.delete(sessionId);
}

/** Simple row-count cap, mirroring pruneLogs but without the byte tracking — few rows to begin with. */
export function pruneAgentMessages(
  dbHandle: Database,
  sessionId: string,
  cap = AGENT_MESSAGE_CAP,
): void {
  const row = dbHandle
    .query('SELECT COUNT(*) AS n FROM agent_messages WHERE session_id = $sessionId')
    .get({ $sessionId: sessionId }) as { n: number };
  if (row.n <= cap) return;
  dbHandle
    .query(`
      DELETE FROM agent_messages WHERE session_id = $sessionId AND seq <= (
        SELECT seq FROM agent_messages WHERE session_id = $sessionId
        ORDER BY seq DESC LIMIT 1 OFFSET $cap
      )
    `)
    .run({ $sessionId: sessionId, $cap: cap });
}
