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
  // seq is optional: toFrame assigns one so replay/persistence can order it
  // alongside the rest of the run, but ad-hoc synthetic errors sent straight
  // from noiseSessionProtocol.ts (start/prompt failures, not a driver event)
  // have no run to order against and omit it.
  | { t: 'agent.error'; seq?: number; message: string };

export interface AgentDriver {
  start(cwd: string): Promise<void>;
  prompt(text: string): AsyncIterable<AgentEvent>;
  interrupt(): void;
  close(): void;
}

export class FakeAgentDriver implements AgentDriver {
  private call = 0;
  /** Observable for tests asserting a driver was spawned/torn down at most once. */
  startCount = 0;
  closed = false;
  constructor(private readonly scripts: AgentEvent[][]) {}
  async start(_cwd: string): Promise<void> {
    this.startCount += 1;
  }
  async *prompt(_text: string): AsyncIterable<AgentEvent> {
    const script = this.scripts[this.call++] ?? [];
    for (const ev of script) yield ev;
  }
  interrupt(): void {}
  close(): void {
    this.closed = true;
  }
}
