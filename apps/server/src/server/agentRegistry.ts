import { AgentClaudeDriver } from './agentClaudeDriver';
import type { AgentDriver, AgentFrame } from './agentDriver';
import { FrameSeq, toFrame } from './agentEventMap';
import { type AgentMessageInsert, appendAgentMessage, maxAgentSeq } from './agentMessages';
import { db } from './db';

export type FrameSink = (f: AgentFrame) => void;
/** Injectable so tests can spy on writes without touching the real DB. */
export type PersistFn = (row: AgentMessageInsert) => void;
/** The seq to resume numbering AFTER — the max already persisted for a session. */
export type SeqSeedFn = (sessionId: string) => number;

function defaultPersist(row: AgentMessageInsert): void {
  appendAgentMessage(db, row);
}

function defaultSeqSeed(sessionId: string): number {
  return maxAgentSeq(db, sessionId);
}

/** Accumulates streamed delta text between two non-delta frames, so the DB
 * gets one coalesced row per assistant "turn of typing" instead of one per
 * chunk — deltas can arrive dozens-to-hundreds of times per reply. */
interface DeltaBuffer {
  text: string;
  seq: number;
}

interface Entry {
  driver: AgentDriver;
  seq: FrameSeq;
  sinks: Set<FrameSink>;
  deltaBuf: DeltaBuffer | null;
}

export class AgentRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly driverFactory: () => AgentDriver,
    private readonly persist: PersistFn = defaultPersist,
    private readonly seqSeed: SeqSeedFn = defaultSeqSeed,
  ) {}

  async start(id: string, cwd: string): Promise<void> {
    if (this.entries.has(id)) return;
    const driver = this.driverFactory();
    await driver.start(cwd);
    // Continue seq numbering from the persisted max so a server restart never
    // reuses seqs (which would overwrite stored rows and make clients drop the
    // new frames as replays).
    const seq = new FrameSeq(this.seqSeed(id));
    this.entries.set(id, { driver, seq, sinks: new Set(), deltaBuf: null });
  }

  attach(id: string, sink: FrameSink): () => void {
    const e = this.entries.get(id);
    if (!e) throw new Error(`no agent session ${id}`);
    e.sinks.add(sink);
    return () => e.sinks.delete(sink);
  }

  /** Flush any buffered delta text as one persisted row, then clear the buffer. */
  private flushDelta(id: string, e: Entry): void {
    if (!e.deltaBuf) return;
    this.persist({ sessionId: id, seq: e.deltaBuf.seq, kind: 'delta', text: e.deltaBuf.text });
    e.deltaBuf = null;
  }

  private persistFrame(id: string, e: Entry, frame: AgentFrame): void {
    if (frame.t === 'agent.delta') {
      // Buffered, not persisted yet — see flushDelta.
      e.deltaBuf = e.deltaBuf
        ? { text: e.deltaBuf.text + frame.text, seq: e.deltaBuf.seq }
        : { text: frame.text, seq: frame.seq };
      return;
    }
    this.flushDelta(id, e);
    if (frame.t === 'agent.tool') {
      this.persist({
        sessionId: id,
        seq: frame.seq,
        kind: 'tool',
        toolJson: JSON.stringify({ name: frame.name, input: frame.input }),
      });
    } else if (frame.t === 'agent.tool_result') {
      this.persist({
        sessionId: id,
        seq: frame.seq,
        kind: 'tool_result',
        text: frame.text,
        isError: frame.isError,
      });
    } else if (frame.t === 'agent.done') {
      this.persist({
        sessionId: id,
        seq: frame.seq,
        kind: 'done',
        toolJson: JSON.stringify({ cost: frame.cost, usage: frame.usage }),
      });
    } else if (frame.t === 'agent.error' && frame.seq !== undefined) {
      // Only a driver-stream error (from toFrame) carries a seq and belongs in
      // the transcript; synthetic errors sent straight from the protocol layer
      // (agent start/prompt failures) have none and are never persisted here.
      this.persist({ sessionId: id, seq: frame.seq, kind: 'error', text: frame.message });
    }
  }

  async prompt(id: string, text: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`no agent session ${id}`);
    // Record + fan out the user's prompt first, seq-ordered ahead of the reply
    // it triggers, so it persists for replay and reaches every attached device.
    const userFrame: AgentFrame = { t: 'agent.user', seq: e.seq.next(), text };
    this.persist({ sessionId: id, seq: userFrame.seq, kind: 'user', text });
    for (const sink of e.sinks) sink(userFrame);
    for await (const ev of e.driver.prompt(text)) {
      const frame = toFrame(ev, e.seq);
      this.persistFrame(id, e, frame);
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

  /** The model the running driver reported, or null if not yet known. */
  modelOf(id: string): string | null {
    return this.entries.get(id)?.driver.getModel?.() ?? null;
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
