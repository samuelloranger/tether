import { matchCommands } from './agentCommands';
import { deriveDiff, summarize } from './agentDiff';
import type { AgentFrame } from './agentFrames';
import type {
  AgentMessage,
  AgentStatus,
  AgentTurn,
  AgentUsage,
  ClaudeSessionMeta,
} from './agentTypes';

/** Map the server's `done` cost + usage blob into our AgentUsage. */
function toUsage(cost: number | undefined, usage: unknown): AgentUsage | undefined {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      if (typeof u[k] === 'number') return u[k] as number;
    }
    return 0;
  };
  const inputTokens = num('inputTokens', 'input_tokens');
  const outputTokens = num('outputTokens', 'output_tokens');
  if (!inputTokens && !outputTokens && cost == null) return undefined;
  return { inputTokens, outputTokens, costUsd: cost };
}

/** Sum every message's usage into one session total, or null if none. */
function sumUsage(messages: AgentMessage[]): AgentUsage | null {
  let seen = false;
  const total: AgentUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const m of messages) {
    if (!m.usage) continue;
    seen = true;
    total.inputTokens += m.usage.inputTokens;
    total.outputTokens += m.usage.outputTokens;
    total.costUsd = (total.costUsd ?? 0) + (m.usage.costUsd ?? 0);
  }
  if (!seen) return null;
  if (!total.costUsd) total.costUsd = undefined;
  return total;
}

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
  /** True when the last turn errored and there is a prompt to resend. */
  canRetry: boolean;
  /** Running total across every turn in this chat; null until the first done. */
  sessionUsage: AgentUsage | null;
  /** Model + account 5h/7day usage from the server; null until first status. */
  status: AgentStatus | null;
  /** Highlighted row in the slash-command palette (0 when closed). */
  paletteIndex: number;
  /** Which sub-picker is open over the composer, or null. */
  pendingPicker: 'model' | 'resume' | null;
  /** Past Claude sessions for the /resume picker (from agent.sessions). */
  resumeSessions: ClaudeSessionMeta[];
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
  private statusValue: AgentStatus | null = null;
  private lastUserPrompt: string | null = null;
  private paletteIndex = 0;
  private pendingPicker: 'model' | 'resume' | null = null;
  private resumeSessions: ClaudeSessionMeta[] = [];
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
        canRetry: this.turn === 'idle' && this.lastUserPrompt != null,
        sessionUsage: sumUsage(this.messages),
        status: this.statusValue,
        paletteIndex: this.paletteIndex,
        pendingPicker: this.pendingPicker,
        resumeSessions: this.resumeSessions,
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

  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: one seq-ordered frame dispatch switch, clearest kept whole
  apply(frame: AgentFrame): void {
    // permission_req carries no seq; everything else is seq-ordered and deduped.
    if ('seq' in frame && typeof frame.seq === 'number') {
      if (frame.seq <= this.lastSeqValue) return;
      this.lastSeqValue = frame.seq;
    }
    switch (frame.t) {
      case 'agent.user': {
        this.messages = [
          ...this.messages,
          {
            id: `u${frame.seq}`,
            role: 'user',
            blocks: [{ type: 'text', text: frame.text }],
            isStreaming: false,
          },
        ];
        this.lastUserPrompt = frame.text;
        this.turn = 'thinking';
        break;
      }
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
        if (last?.isStreaming) {
          this.replaceLast({
            ...last,
            isStreaming: false,
            usage: toUsage(frame.cost, frame.usage),
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
        const inputJson = JSON.stringify(frame.input ?? {});
        const msg = this.streamingAssistant();
        const tool = {
          id: `t${this.lastSeqValue}-${msg.blocks.length}`,
          name: frame.name,
          summary: summarize(frame.name, inputJson),
          inputJson,
          isError: false,
          diff: deriveDiff(frame.name, inputJson),
        };
        this.replaceLast({ ...msg, blocks: [...msg.blocks, { type: 'tool', tool }] });
        this.turn = 'thinking';
        break;
      }
      case 'agent.tool_result': {
        this.fillLastToolResult(frame.text, frame.isError);
        break;
      }
      case 'agent.status': {
        // Merge: a later status with a known model but no fresh usage (or vice
        // versa) must not wipe the field we already have.
        const prev = this.statusValue;
        this.statusValue = {
          model: frame.model ?? prev?.model ?? null,
          fiveHour: frame.fiveHour ?? prev?.fiveHour ?? null,
          sevenDay: frame.sevenDay ?? prev?.sevenDay ?? null,
        };
        break;
      }
      case 'agent.sessions': {
        this.resumeSessions = frame.sessions;
        break;
      }
      case 'agent.permission_req': {
        const inputJson = JSON.stringify(frame.input ?? {});
        const req = {
          id: frame.reqId,
          name: frame.name,
          summary: summarize(frame.name, inputJson),
        };
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

  /** Optimistically flip to a busy turn the instant a prompt is sent. The user
   * bubble itself arrives as an echoed `agent.user` frame — server-authoritative,
   * so it persists across reconnect and reaches every attached device. */
  notePromptSent(): void {
    this.turn = 'thinking';
    this.changed();
  }

  /** Drop a trailing error row and re-arm for the last prompt; the caller
   * resends it. Returns the prompt, or null when there is nothing to retry. */
  retryLast(): string | null {
    if (this.turn !== 'idle' || this.lastUserPrompt == null) return null;
    if (this.messages.at(-1)?.role === 'error') {
      this.messages = this.messages.slice(0, -1);
    }
    this.turn = 'thinking';
    this.changed();
    return this.lastUserPrompt;
  }

  setDraft(text: string): void {
    this.draft = text;
    const count = matchCommands(text).length;
    this.paletteIndex = count === 0 ? 0 : Math.min(this.paletteIndex, count - 1);
    this.changed();
  }

  movePalette(delta: number): void {
    const count = matchCommands(this.draft).length;
    if (count === 0) return;
    this.paletteIndex = (this.paletteIndex + delta + count) % count;
    this.changed();
  }

  openPicker(kind: 'model' | 'resume'): void {
    this.pendingPicker = kind;
    this.changed();
  }

  closePicker(): void {
    this.pendingPicker = null;
    this.changed();
  }

  clearTranscript(): void {
    this.messages = [];
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

  /** Cancel one queued prompt before it is sent. */
  removeQueued(index: number): void {
    if (index < 0 || index >= this.queued.length) return;
    this.queued = this.queued.filter((_, i) => i !== index);
    this.changed();
  }

  /** Attach a result to the most recent tool block that has none — the server's
   * tool_result carries no id (results arrive in tool order). */
  private fillLastToolResult(text: string, isError: boolean): void {
    for (let mi = this.messages.length - 1; mi >= 0; mi--) {
      const msg = this.messages[mi];
      for (let bi = msg.blocks.length - 1; bi >= 0; bi--) {
        const block = msg.blocks[bi];
        if (block.type === 'tool' && block.tool.result === undefined) {
          const blocks = [...msg.blocks];
          blocks[bi] = { type: 'tool', tool: { ...block.tool, result: text, isError } };
          this.messages = [
            ...this.messages.slice(0, mi),
            { ...msg, blocks },
            ...this.messages.slice(mi + 1),
          ];
          return;
        }
      }
    }
  }
}
