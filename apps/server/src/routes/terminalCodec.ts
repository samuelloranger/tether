/**
 * Two WebSocket codecs over one handler set. proto=1 (default) is today's JSON
 * protocol byte-for-byte — key order is a compat surface, not style; proto=2 is binary.
 */

import type { DiffSummary } from '../gitDiff';
import type { RepoStatus } from '../gitStatus';
import { type Bytes, concatFrames, FrameDecoder } from '../proto/frame';
import {
  type ClientMessage,
  decodeClientFrame,
  encodeActivityFrame,
  encodeCursorFrame,
  encodeDiffFrame,
  encodeExitFrame,
  encodeOutputFrame,
  encodePingFrame,
  encodeResetFrame,
  encodeTitleFrame,
} from '../proto/wireCodec';
import { encodeReplayCursor, replayPositionFromCursor } from '../replayCursor';
import type { ReplayOutputFrame } from '../replayPlan';
import type { Activity } from '../sessionActivity';

export type { ClientMessage } from '../proto/wireCodec';

/** What a codec hands the socket: a JSON string (v1) or framed bytes (v2). */
export type WireData = string | Bytes;

export interface TerminalCodec {
  readonly proto: 1 | 2;
  /** Live PTY output. `id` is the log row the chunk ends at. */
  liveOutput(chunk: string, id: number): WireData;
  /** A coalesced replay frame. Separate from `liveOutput` only because v1's
   *  two paths emit their JSON keys in a different order. */
  replayOutput(frame: ReplayOutputFrame): WireData;
  exit(exitCode?: number): WireData;
  /** Null when the protocol does not carry this frame (v1 has no title). */
  title(title: string): WireData | null;
  activity(activity: Activity): WireData;
  diff(summary: DiffSummary, status?: RepoStatus): WireData;
  reset(): WireData;
  ping(): WireData;
  /** Decodes an inbound socket message; may yield several frames per message. */
  decode(data: unknown): ClientMessage[];
  replayFrom(query: { sinceId: string | null; cursor: string | null }, sessionId: string): number;
}

class JsonCodec implements TerminalCodec {
  readonly proto = 1 as const;

  liveOutput(chunk: string, id: number): WireData {
    return JSON.stringify({ type: 'output', chunk, id });
  }

  replayOutput(frame: ReplayOutputFrame): WireData {
    return JSON.stringify(frame);
  }

  exit(exitCode?: number): WireData {
    return JSON.stringify({ type: 'exit', exitCode });
  }

  title(): null {
    return null;
  }

  activity(activity: Activity): WireData {
    return JSON.stringify({ type: 'activity', activity });
  }

  diff(summary: DiffSummary, status?: RepoStatus): WireData {
    return JSON.stringify({ type: 'diff', summary, status });
  }

  reset(): WireData {
    return JSON.stringify({ type: 'reset' });
  }

  ping(): WireData {
    return JSON.stringify({ type: 'ping' });
  }

  decode(data: unknown): ClientMessage[] {
    const msg = JSON.parse(data as string);
    if (msg.type === 'input' && typeof msg.text === 'string') {
      return [{ type: 'input', text: msg.text }];
    }
    if (msg.type === 'resize') {
      return [{ type: 'resize', cols: Number(msg.cols), rows: Number(msg.rows) }];
    }
    if (msg.type === 'focus' && typeof msg.focused === 'boolean') {
      return [{ type: 'focus', focused: msg.focused }];
    }
    return [];
  }

  replayFrom(query: { sinceId: string | null }): number {
    return Number(query.sinceId || 0);
  }
}

class BinaryCodec implements TerminalCodec {
  readonly proto = 2 as const;
  // One decoder per socket: a client is free to pack several frames into one WS
  // message, or split one frame across two.
  private readonly decoder = new FrameDecoder();

  constructor(private readonly sessionId: string) {}

  // Output and its cursor go out as one write: the cursor is what the client
  // stores to resume, so it must never lag the bytes it acknowledges.
  private outputWithCursor(chunk: string, id: number): WireData {
    return concatFrames([
      encodeOutputFrame(chunk),
      encodeCursorFrame(encodeReplayCursor(this.sessionId, id)),
    ]);
  }

  liveOutput(chunk: string, id: number): WireData {
    return this.outputWithCursor(chunk, id);
  }

  replayOutput(frame: ReplayOutputFrame): WireData {
    return this.outputWithCursor(frame.chunk, frame.id);
  }

  exit(exitCode?: number): WireData {
    return encodeExitFrame(exitCode);
  }

  title(title: string): WireData {
    return encodeTitleFrame(title);
  }

  activity(activity: Activity): WireData {
    return encodeActivityFrame(activity);
  }

  diff(summary: DiffSummary, status?: RepoStatus): WireData {
    return encodeDiffFrame(summary, status);
  }

  reset(): WireData {
    return encodeResetFrame();
  }

  ping(): WireData {
    return encodePingFrame();
  }

  decode(data: unknown): ClientMessage[] {
    const bytes = toBytes(data);
    if (!bytes) return [];
    const out: ClientMessage[] = [];
    for (const frame of this.decoder.push(bytes)) {
      const msg = decodeClientFrame(frame);
      if (msg) out.push(msg);
    }
    return out;
  }

  replayFrom(query: { cursor: string | null }): number {
    return replayPositionFromCursor(query.cursor, this.sessionId);
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return null;
}

/** Unknown/absent `proto` is v1: an old client must never be handed binary. */
export function codecFor(proto: string | null, sessionId: string): TerminalCodec {
  return proto === '2' ? new BinaryCodec(sessionId) : new JsonCodec();
}
