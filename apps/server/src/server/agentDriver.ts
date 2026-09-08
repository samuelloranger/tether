export type AgentEvent =
  | { t: 'delta'; text: string }
  | { t: 'tool'; name: string; input: unknown }
  | { t: 'tool_result'; text: string; isError: boolean }
  | { t: 'permission_req'; reqId: string; name: string; input: unknown }
  | { t: 'done'; cost: number; usage: unknown }
  | { t: 'error'; message: string };

export type AgentFrame =
  | { t: 'agent.delta'; seq: number; text: string }
  | { t: 'agent.tool'; seq: number; name: string; input: unknown }
  | { t: 'agent.tool_result'; seq: number; text: string; isError: boolean }
  | { t: 'agent.permission_req'; reqId: string; name: string; input: unknown }
  | { t: 'agent.done'; seq: number; cost: number; usage: unknown }
  | { t: 'agent.error'; message: string };

export interface AgentDriver {
  start(cwd: string): Promise<void>;
  prompt(text: string): AsyncIterable<AgentEvent>;
  interrupt(): void;
  close(): void;
}

export class FakeAgentDriver implements AgentDriver {
  private call = 0;
  constructor(private readonly scripts: AgentEvent[][]) {}
  async start(_cwd: string): Promise<void> {}
  async *prompt(_text: string): AsyncIterable<AgentEvent> {
    const script = this.scripts[this.call++] ?? [];
    for (const ev of script) yield ev;
  }
  interrupt(): void {}
  close(): void {}
}
