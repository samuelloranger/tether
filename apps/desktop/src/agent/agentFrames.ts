export type AgentFrame =
  | { t: 'agent.delta'; seq: number; text: string }
  | {
      t: 'agent.tool';
      seq: number;
      id: string;
      name: string;
      summary: string;
      inputJson: string;
    }
  | { t: 'agent.tool_result'; seq: number; id: string; result: string; isError: boolean }
  | {
      t: 'agent.permission_req';
      seq: number;
      id: string;
      name: string;
      summary: string;
      inputJson: string;
    }
  | {
      t: 'agent.done';
      seq: number;
      usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
    }
  | { t: 'agent.error'; seq: number; message: string };

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

export function agentPermission(input: { id: string; allow: boolean }) {
  return { t: 'agent.permission' as const, id: input.id, allow: input.allow };
}
