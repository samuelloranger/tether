import type { AgentFrame } from './agentFrames';
import type { AgentMessage, AgentTurn, AgentUsage } from './agentTypes';

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
      default:
        // tool / tool_result / permission_req handled in later methods.
        break;
    }
    this.changed();
  }
}
