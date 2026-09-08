import { deriveDiff } from './agentDiff';
import type { AgentFrame } from './agentFrames';
import type { AgentBlock, AgentMessage, AgentTurn, AgentUsage } from './agentTypes';

export interface PendingApproval {
  id: string;
  name: string;
  summary: string;
}

export interface AgentSnapshot {
  messages: AgentMessage[];
  turn: AgentTurn;
  lastSeq: number;
  revision: number;
  pendingApproval: PendingApproval | null;
  queued: string[];
  draft: string;
}

/**
 * Framework-agnostic reducer for one agent chat. Frames are fed via `apply`;
 * React subscribes through `subscribe`/`snapshot` (useSyncExternalStore).
 * Port of Swift AgentChatModel (AgentChatModel.swift:13).
 */
export class AgentChatModel {
  private messages: AgentMessage[] = [];
  private turn: AgentTurn = 'idle';
  private lastSeqValue = 0;
  private revision = 0;
  private pendingApproval: PendingApproval | null = null;
  private approvalBacklog: PendingApproval[] = [];
  private queued: string[] = [];
  private draft = '';
  private listeners = new Set<() => void>();
  private cached: AgentSnapshot | null = null;

  get lastSeq(): number {
    return this.lastSeqValue;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): AgentSnapshot => {
    if (!this.cached) {
      this.cached = {
        messages: this.messages,
        turn: this.turn,
        lastSeq: this.lastSeqValue,
        revision: this.revision,
        pendingApproval: this.pendingApproval,
        queued: this.queued,
        draft: this.draft,
      };
    }
    return this.cached;
  };

  private changed(): void {
    this.revision += 1;
    this.cached = null;
    for (const fn of this.listeners) fn();
  }

  private streamingAssistant(): AgentMessage {
    const last = this.messages.at(-1);
    if (last && last.role === 'assistant' && last.isStreaming) return last;
    const msg: AgentMessage = {
      id: `a${this.revision}-${this.messages.length}`,
      role: 'assistant',
      blocks: [],
      isStreaming: true,
    };
    this.messages = [...this.messages, msg];
    return msg;
  }

  private replaceLast(msg: AgentMessage): void {
    this.messages = [...this.messages.slice(0, -1), msg];
  }

  apply(frame: AgentFrame): void {
    if (frame.seq <= this.lastSeqValue) return;
    this.lastSeqValue = frame.seq;
    switch (frame.t) {
      case 'agent.delta': {
        const msg = this.streamingAssistant();
        const blocks = [...msg.blocks];
        const tail = blocks.at(-1);
        if (tail && tail.type === 'text') {
          blocks[blocks.length - 1] = { type: 'text', text: tail.text + frame.text };
        } else {
          blocks.push({ type: 'text', text: frame.text });
        }
        this.replaceLast({ ...msg, blocks });
        this.turn = 'streaming';
        break;
      }
      case 'agent.done': {
        const last = this.messages.at(-1);
        if (last && last.isStreaming) {
          this.replaceLast({
            ...last,
            isStreaming: false,
            usage: frame.usage as AgentUsage | undefined,
          });
        }
        this.turn = 'idle';
        break;
      }
      case 'agent.error': {
        this.messages = [
          ...this.messages,
          {
            id: `e${this.lastSeqValue}`,
            role: 'error',
            blocks: [{ type: 'text', text: frame.message }],
            isStreaming: false,
          },
        ];
        this.turn = 'idle';
        break;
      }
      case 'agent.tool': {
        const msg = this.streamingAssistant();
        const tool = {
          id: frame.id,
          name: frame.name,
          summary: frame.summary,
          inputJson: frame.inputJson,
          isError: false,
        };
        this.replaceLast({ ...msg, blocks: [...msg.blocks, { type: 'tool', tool }] });
        this.turn = 'thinking';
        break;
      }
      case 'agent.tool_result': {
        this.attachToolResult(frame.id, frame.result, frame.isError);
        break;
      }
      case 'agent.permission_req': {
        const req = { id: frame.id, name: frame.name, summary: frame.summary };
        if (this.pendingApproval) {
          this.approvalBacklog = [...this.approvalBacklog, req];
        } else {
          this.pendingApproval = req;
        }
        break;
      }
      default:
        break;
    }
    this.changed();
  }

  /** Pop the current approval, promote the next, return the id to reply for. */
  resolvePermission(_allow: boolean): { id: string } | null {
    const current = this.pendingApproval;
    if (!current) return null;
    this.pendingApproval = this.approvalBacklog[0] ?? null;
    this.approvalBacklog = this.approvalBacklog.slice(1);
    this.changed();
    return { id: current.id };
  }

  /** Echo the user's own prompt into the transcript immediately (the server
   * never sends it back as a frame). */
  pushUserPrompt(text: string): void {
    this.messages = [
      ...this.messages,
      {
        id: `u${this.messages.length}-${Date.now()}`,
        role: 'user',
        blocks: [{ type: 'text', text }],
        isStreaming: false,
      },
    ];
    this.turn = 'thinking';
    this.changed();
  }

  setDraft(text: string): void {
    this.draft = text;
    this.changed();
  }

  enqueue(text: string): void {
    this.queued = [...this.queued, text];
    this.changed();
  }

  dequeue(): string | null {
    if (this.queued.length === 0) return null;
    const [next, ...rest] = this.queued;
    this.queued = rest;
    this.changed();
    return next;
  }

  private attachToolResult(id: string, result: string, isError: boolean): void {
    this.messages = this.messages.map((msg) => {
      const idx = msg.blocks.findIndex((b) => b.type === 'tool' && b.tool.id === id);
      if (idx < 0) return msg;
      const block = msg.blocks[idx] as Extract<AgentBlock, { type: 'tool' }>;
      const diff = deriveDiff(block.tool.name, block.tool.inputJson);
      const blocks = [...msg.blocks];
      blocks[idx] = { type: 'tool', tool: { ...block.tool, result, isError, diff } };
      return { ...msg, blocks };
    });
  }
}
