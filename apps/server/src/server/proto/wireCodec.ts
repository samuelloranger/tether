/**
 * Protocol v2 message codec: domain values <-> protobuf <-> framed bytes.
 *
 * The frame kinds live in the schema (`FrameKind` in wire.proto) so the Rust and
 * TypeScript sides cannot drift, and both directions read them from the same
 * enum. `OUTPUT` is deliberately not a protobuf message — it carries raw PTY
 * bytes, which is the entire point of v2 on the hot path.
 */

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { DiffSummary as DomainDiffSummary } from '../gitDiff';
import type { RepoStatus as DomainRepoStatus } from '../gitStatus';
import type { Activity as DomainActivity } from '../sessionActivity';
import { type Bytes, type DecodedFrame, encodeFrame } from './frame';
import {
  Activity,
  ActivityFrameSchema,
  CursorFrameSchema,
  DiffFrameSchema,
  ExitFrameSchema,
  FocusFrameSchema,
  FrameKind,
  InputFrameSchema,
  PingFrameSchema,
  ResetFrameSchema,
  ResizeFrameSchema,
  TitleFrameSchema,
} from './gen/wire_pb';

export { FrameKind } from './gen/wire_pb';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

const ACTIVITY_TO_PROTO: Record<DomainActivity, Activity> = {
  working: Activity.WORKING,
  waiting: Activity.WAITING,
  idle: Activity.IDLE,
};

const ACTIVITY_FROM_PROTO: Partial<Record<Activity, DomainActivity>> = {
  [Activity.WORKING]: 'working',
  [Activity.WAITING]: 'waiting',
  [Activity.IDLE]: 'idle',
};

/** Raw PTY bytes, no wrapper. */
export function encodeOutputFrame(chunk: string | Uint8Array): Bytes {
  return encodeFrame(FrameKind.OUTPUT, typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
}

export function encodeCursorFrame(cursor: string): Bytes {
  return encodeFrame(
    FrameKind.CURSOR,
    toBinary(CursorFrameSchema, create(CursorFrameSchema, { cursor })),
  );
}

export function encodeExitFrame(exitCode?: number): Bytes {
  const msg = create(ExitFrameSchema, exitCode === undefined ? {} : { exitCode });
  return encodeFrame(FrameKind.EXIT, toBinary(ExitFrameSchema, msg));
}

export function encodeTitleFrame(title: string): Bytes {
  return encodeFrame(
    FrameKind.TITLE,
    toBinary(TitleFrameSchema, create(TitleFrameSchema, { title })),
  );
}

export function encodeActivityFrame(activity: DomainActivity): Bytes {
  const msg = create(ActivityFrameSchema, { activity: ACTIVITY_TO_PROTO[activity] });
  return encodeFrame(FrameKind.ACTIVITY, toBinary(ActivityFrameSchema, msg));
}

export function encodeDiffFrame(summary: DomainDiffSummary, status?: DomainRepoStatus): Bytes {
  const msg = create(DiffFrameSchema, {
    summary: { files: summary.files.map((f) => ({ ...f })) },
    status: status ? { ...status, upstream: status.upstream ?? undefined } : undefined,
  });
  return encodeFrame(FrameKind.DIFF, toBinary(DiffFrameSchema, msg));
}

export function encodeResetFrame(): Bytes {
  return encodeFrame(FrameKind.RESET, toBinary(ResetFrameSchema, create(ResetFrameSchema)));
}

export function encodePingFrame(): Bytes {
  return encodeFrame(FrameKind.PING, toBinary(PingFrameSchema, create(PingFrameSchema)));
}

export type ClientMessage =
  | { type: 'input'; text: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'focus'; focused: boolean };

/** Decodes one client->server frame. Returns null for kinds we don't serve. */
export function decodeClientFrame(frame: DecodedFrame): ClientMessage | null {
  switch (frame.kind) {
    case FrameKind.INPUT: {
      const msg = fromBinary(InputFrameSchema, frame.payload);
      return { type: 'input', text: decoder.decode(msg.data) };
    }
    case FrameKind.RESIZE: {
      const msg = fromBinary(ResizeFrameSchema, frame.payload);
      return { type: 'resize', cols: msg.cols, rows: msg.rows };
    }
    case FrameKind.FOCUS: {
      const msg = fromBinary(FocusFrameSchema, frame.payload);
      return { type: 'focus', focused: msg.focused };
    }
    default:
      return null;
  }
}

// --- decoders for the far side of the wire, used by conformance tests and by
// any TypeScript client (the Rust client reads the same schema).

export function decodeCursorFrame(payload: Uint8Array): string {
  return fromBinary(CursorFrameSchema, payload).cursor;
}

export function decodeExitFrame(payload: Uint8Array): number | undefined {
  return fromBinary(ExitFrameSchema, payload).exitCode;
}

export function decodeTitleFrame(payload: Uint8Array): string {
  return fromBinary(TitleFrameSchema, payload).title;
}

export function decodeActivityFrame(payload: Uint8Array): DomainActivity | null {
  return ACTIVITY_FROM_PROTO[fromBinary(ActivityFrameSchema, payload).activity] ?? null;
}

export function decodeDiffFrame(payload: Uint8Array): {
  summary: DomainDiffSummary;
  status: DomainRepoStatus | null;
} {
  const msg = fromBinary(DiffFrameSchema, payload);
  return {
    summary: {
      files: (msg.summary?.files ?? []).map((f) => ({
        path: f.path,
        insertions: f.insertions,
        deletions: f.deletions,
        binary: f.binary,
        ...(f.staged === undefined ? {} : { staged: f.staged }),
      })),
    },
    status: msg.status
      ? {
          branch: msg.status.branch,
          shortSha: msg.status.shortSha,
          detached: msg.status.detached,
          upstream: msg.status.upstream ?? null,
          ahead: msg.status.ahead,
          behind: msg.status.behind,
        }
      : null,
  };
}

/** Encodes a client->server message — the client half of the codec. */
export function encodeClientMessage(msg: ClientMessage): Bytes {
  switch (msg.type) {
    case 'input':
      return encodeFrame(
        FrameKind.INPUT,
        toBinary(InputFrameSchema, create(InputFrameSchema, { data: encoder.encode(msg.text) })),
      );
    case 'resize':
      return encodeFrame(
        FrameKind.RESIZE,
        toBinary(ResizeFrameSchema, create(ResizeFrameSchema, { cols: msg.cols, rows: msg.rows })),
      );
    case 'focus':
      return encodeFrame(
        FrameKind.FOCUS,
        toBinary(FocusFrameSchema, create(FocusFrameSchema, { focused: msg.focused })),
      );
  }
}
