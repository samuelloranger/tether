import { AgentClaudeDriver } from './agentClaudeDriver';
import type { AgentDriver, AgentFrame } from './agentDriver';
import { FrameSeq, toFrame } from './agentEventMap';

export type FrameSink = (f: AgentFrame) => void;

interface Entry {
  driver: AgentDriver;
  seq: FrameSeq;
  sinks: Set<FrameSink>;
}

export class AgentRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly driverFactory: () => AgentDriver) {}

  async start(id: string, cwd: string): Promise<void> {
    if (this.entries.has(id)) return;
    const driver = this.driverFactory();
    await driver.start(cwd);
    this.entries.set(id, { driver, seq: new FrameSeq(), sinks: new Set() });
  }

  attach(id: string, sink: FrameSink): () => void {
    const e = this.entries.get(id);
    if (!e) throw new Error(`no agent session ${id}`);
    e.sinks.add(sink);
    return () => e.sinks.delete(sink);
  }

  async prompt(id: string, text: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`no agent session ${id}`);
    for await (const ev of e.driver.prompt(text)) {
      const frame = toFrame(ev, e.seq);
      for (const sink of e.sinks) sink(frame);
    }
  }

  interrupt(id: string): void {
    this.entries.get(id)?.driver.interrupt();
  }

  kill(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.driver.close();
    this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  killAll(): void {
    for (const e of this.entries.values()) e.driver.close();
    this.entries.clear();
  }
}

/**
 * Server-owned, one per process — NOT per Noise connection. Agent sessions
 * must outlive a client disconnect (app close, network drop), the same way
 * PTY sessions outlive them via the module-level singletons in `pty.ts`.
 * Killing an agent is explicit only (the drawer kill button / REST kill route).
 */
export const sharedAgentRegistry = new AgentRegistry(() => new AgentClaudeDriver());
