import type { AgentFrame } from './agentDriver';
import { type AgentMessageRow, getAgentMessages } from './agentMessages';
import { createAgentSession, db } from './db';
import { logError } from './log';
import type { AgentState, SessionDeps } from './noiseSessionProtocol';

export function defaultGetAgentMessages(sessionId: string, sinceSeq: number): AgentMessageRow[] {
  return getAgentMessages(db, sessionId, sinceSeq);
}

/** Reconstruct the `agent.*` wire frame a stored row represents, for replay. */
export function rowToAgentFrame(row: AgentMessageRow): AgentFrame | null {
  switch (row.kind) {
    case 'delta':
      return { t: 'agent.delta', seq: row.seq, text: row.text ?? '' };
    case 'tool': {
      const { name, input } = JSON.parse(row.tool_json ?? '{}') as { name: string; input: unknown };
      return { t: 'agent.tool', seq: row.seq, name, input };
    }
    case 'tool_result':
      return {
        t: 'agent.tool_result',
        seq: row.seq,
        text: row.text ?? '',
        isError: row.is_error === 1,
      };
    case 'done': {
      const { cost, usage } = JSON.parse(row.tool_json ?? '{}') as { cost: number; usage: unknown };
      return { t: 'agent.done', seq: row.seq, cost, usage };
    }
    case 'error':
      return { t: 'agent.error', seq: row.seq, message: row.text ?? '' };
    default:
      return null;
  }
}

/**
 * Handle `agent.start`: (re)spawn/attach the driver, then replay any stored
 * frames the client missed (seq > sinceSeq) BEFORE attaching the live sink, so
 * a reconnect never interleaves replay with fresh frames. A cold client
 * (empty model) sends sinceSeq 0 → full-transcript replay. Extracted from
 * noiseSessionProtocol's applyMessage to keep that file under the line-count
 * limit and to keep the replay reconstruction (rowToAgentFrame) colocated.
 */
export async function applyAgentStart(
  msg: { t: 'agent.start'; id: string; cwd: string; sinceSeq?: number },
  d: SessionDeps,
  sendSealed: (obj: unknown) => boolean,
  agent: AgentState,
): Promise<void> {
  try {
    // If the agent is already running (server-owned, survives disconnects),
    // this is a reconnect — re-attach to the live driver instead of starting
    // a second one. Only a first open creates the DB row + spawns the driver.
    if (!agent.registry.has(msg.id)) {
      createAgentSession(db, { id: msg.id, workspaceRoot: msg.cwd });
      await agent.registry.start(msg.id, msg.cwd);
    }
  } catch (err) {
    logError(`Noise session: agent.start('${msg.id}') failed:`, err);
    sendSealed({ t: 'agent.error', message: 'agent start failed' });
    return;
  }
  agent.attachments.get(msg.id)?.(); // replace any prior subscription (a re-start)

  const sinceSeq =
    typeof msg.sinceSeq === 'number' && Number.isFinite(msg.sinceSeq) ? msg.sinceSeq : 0;
  const rows = d.getAgentMessages(msg.id, sinceSeq);
  for (const row of rows) {
    const frame = rowToAgentFrame(row);
    if (frame && !sendSealed(frame)) return;
  }

  const unsub = agent.registry.attach(msg.id, (frame) => sendSealed(frame));
  agent.attachments.set(msg.id, unsub);
  agent.currentId = msg.id;
}
