import type { UsageWindow } from './agentTypes';

export type AgentFrame =
  | { t: 'agent.user'; seq: number; text: string }
  | { t: 'agent.delta'; seq: number; text: string }
  | { t: 'agent.tool'; seq: number; name: string; input: unknown }
  | { t: 'agent.tool_result'; seq: number; text: string; isError: boolean }
  | { t: 'agent.permission_req'; reqId: string; name: string; input: unknown }
  | { t: 'agent.done'; seq: number; cost?: number; usage?: unknown }
  | { t: 'agent.error'; seq?: number; message: string }
  // Ephemeral, no seq: account model + 5h/7day usage for the info strip.
  | {
      t: 'agent.status';
      model: string | null;
      fiveHour: UsageWindow | null;
      sevenDay: UsageWindow | null;
    };

/** Decode one WS-JSON line into an AgentFrame, or null for non-agent frames. */
export function decodeAgentFrame(json: string): AgentFrame | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  const t = v.t;
  if (typeof t !== 'string' || !t.startsWith('agent.')) return null;
  return v as unknown as AgentFrame;
}

export function agentStart(input: { id: string; cwd: string; sinceSeq: number }) {
  return { t: 'agent.start' as const, id: input.id, cwd: input.cwd, sinceSeq: input.sinceSeq };
}

export function agentPrompt(text: string) {
  return { t: 'agent.prompt' as const, text };
}

export function agentInterrupt() {
  return { t: 'agent.interrupt' as const };
}

export function agentModel(name: string) {
  return { t: 'agent.model' as const, name };
}

export function agentPermission(input: { reqId: string; allow: boolean }) {
  return { t: 'agent.permission' as const, reqId: input.reqId, allow: input.allow };
}
