import type { AgentFrame } from './agentDriver';
import { type AgentMessageRow, appendAgentMessage, getAgentMessages } from './agentMessages';
import { getConfig, patchConfig } from './config';
import { createAgentSession, db, getSession, setSessionModel } from './db';
import { logError } from './log';
import type { AgentState, SessionDeps } from './noiseSessionProtocol';

/** The `agent.*` client messages, dispatched by applyAgentMessage. */
type AgentClientMessage =
  | { t: 'agent.start'; id: string; cwd: string; sinceSeq?: number; resumeClaudeSessionId?: string }
  | { t: 'agent.prompt'; text: string }
  | { t: 'agent.model'; name: string }
  | { t: 'agent.list-sessions'; cwd: string }
  | { t: 'agent.interrupt' };

/** Route one agent-chat message. Extracted from noiseSessionProtocol's
 * applyMessage so that file stays under its size limit. */
export async function applyAgentMessage(
  msg: AgentClientMessage,
  d: SessionDeps,
  sendSealed: (obj: unknown) => boolean,
  agent: AgentState,
): Promise<void> {
  if (msg.t === 'agent.start') {
    await applyAgentStart(msg, d, sendSealed, agent);
  } else if (msg.t === 'agent.prompt') {
    // Un-awaited so `agent.interrupt` can still land while a prompt streams — but
    // a driver can reject mid-stream, and an unhandled rejection would escape the
    // caller's try/catch and crash the process. Catch and report to the client.
    if (agent.currentId) {
      agent.registry.prompt(agent.currentId, msg.text).catch((err) => {
        logError('Noise session: agent.prompt failed:', err);
        sendSealed({ t: 'agent.error', message: 'agent prompt failed' });
      });
    }
  } else if (msg.t === 'agent.model') {
    if (agent.currentId) {
      const name = msg.name || null;
      agent.registry.setModel(agent.currentId, name);
      setSessionModel(db, agent.currentId, name);
      void patchConfig({ agent: { defaultModel: msg.name } });
      void sendAgentStatus(agent.currentId, d, sendSealed, agent);
    }
  } else if (msg.t === 'agent.list-sessions') {
    sendSealed({ t: 'agent.sessions', sessions: d.listClaudeSessions(msg.cwd) });
  } else if (msg.t === 'agent.interrupt') {
    if (agent.currentId) agent.registry.interrupt(agent.currentId);
  }
}

export function defaultGetAgentMessages(sessionId: string, sinceSeq: number): AgentMessageRow[] {
  return getAgentMessages(db, sessionId, sinceSeq);
}

/** Reconstruct the `agent.*` wire frame a stored row represents, for replay. */
export function rowToAgentFrame(row: AgentMessageRow): AgentFrame | null {
  switch (row.kind) {
    case 'user':
      return { t: 'agent.user', seq: row.seq, text: row.text ?? '' };
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
  msg: {
    t: 'agent.start';
    id: string;
    cwd: string;
    sinceSeq?: number;
    resumeClaudeSessionId?: string;
  },
  d: SessionDeps,
  sendSealed: (obj: unknown) => boolean,
  agent: AgentState,
): Promise<void> {
  try {
    // If the agent is already running (server-owned, survives disconnects),
    // this is a reconnect — re-attach to the live driver instead of starting
    // a second one. Only a first open creates the DB row + spawns the driver.
    if (!agent.registry.has(msg.id)) {
      // The persisted workspace_root is authoritative for a resumed chat: after
      // a force-close + relaunch the client rebuilds its model with an empty
      // cwd (it never learns workspace_root from /api/sessions), so trusting
      // msg.cwd here would respawn `claude` in the server's own dir ($HOME)
      // instead of the chat's folder. Fall back to msg.cwd only for a brand-new
      // chat that has no row yet.
      const existing = getSession(msg.id);
      const persisted = existing?.workspace_root ?? null;
      const cwd = persisted && persisted.length > 0 ? persisted : msg.cwd;
      createAgentSession(db, { id: msg.id, workspaceRoot: cwd });
      // Graft the picked Claude session's history into this fresh tab as stored
      // rows (fresh seqs) so the standard replay renders it; the driver then
      // resumes that same Claude session so its context continues live.
      if (msg.resumeClaudeSessionId) {
        const rows = d.translateClaudeSession(msg.resumeClaudeSessionId, cwd);
        let seq = 0;
        for (const r of rows) {
          appendAgentMessage(db, {
            sessionId: msg.id,
            seq: ++seq,
            kind: r.kind,
            text: r.text ?? null,
            toolJson: r.toolJson ?? null,
            isError: r.isError,
          });
        }
      }
      const model = existing?.model ?? (getConfig().agent.defaultModel || null);
      await agent.registry.start(msg.id, cwd, {
        model,
        resumeSessionId: msg.resumeClaudeSessionId,
      });
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

  const unsub = agent.registry.attach(msg.id, (frame) => {
    sendSealed(frame);
    // Usage moves after a turn spends tokens — refresh the strip when one ends.
    if (frame.t === 'agent.done') void sendAgentStatus(msg.id, d, sendSealed, agent);
  });
  agent.attachments.set(msg.id, unsub);
  agent.currentId = msg.id;

  // Push model + 5h/7day usage now, so the strip is populated the moment the
  // chat attaches (before the first prompt of a resumed session).
  void sendAgentStatus(msg.id, d, sendSealed, agent);
}

/**
 * Send an `agent.status` frame: the running model plus the account's 5h/7day
 * usage. Not part of the seq-ordered transcript (never persisted or replayed) —
 * it is ephemeral account state, refreshed on attach and after each turn. Usage
 * is advisory: a null fetch just omits the windows.
 */
export async function sendAgentStatus(
  id: string,
  d: SessionDeps,
  sendSealed: (obj: unknown) => boolean,
  agent: AgentState,
): Promise<void> {
  const limits = await d.fetchAgentUsage().catch(() => null);
  sendSealed({
    t: 'agent.status',
    model: agent.registry.modelOf(id),
    fiveHour: limits?.fiveHour ?? null,
    sevenDay: limits?.sevenDay ?? null,
  });
}
