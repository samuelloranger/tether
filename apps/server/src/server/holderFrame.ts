/**
 * Server <-> holder socket framing.
 *
 * The holder link used to be newline-delimited JSON with base64 payloads, which
 * meant every byte the PTY produced was inflated ~33% and then JSON-escaped on
 * top. It now uses the same length-prefixed framing as protocol v2 (see
 * proto/frame.ts) with raw payloads.
 *
 * Payload encodings are deliberately hand-rolled rather than protobuf: the
 * holder is a detached process on the hottest path in the system, and these six
 * frames are a byte count and two integers. Nothing here needs a schema.
 *
 *   server -> holder:  INPUT (raw bytes) · RESIZE (u16 cols, u16 rows) · KILL ·
 *                      CWDREQ (empty)
 *   holder -> server:  HELLO (u8 version) · OUTPUT (raw bytes) ·
 *                      EXIT (empty | i32 code) · CWD (utf-8 path)
 *
 * ## Legacy coexistence
 *
 * A holder is a *detached* process: it outlives the server, so after an update
 * the new server finds holders still speaking the old newline-JSON dialect, and
 * `reattachHolders()` must adopt them rather than orphan a user's running shell.
 * Both sides therefore sniff the first byte they receive. Legacy frames are JSON
 * objects, so they always start with `{` (0x7b); no binary frame can, because
 * every kind is a small integer. That one byte decides the dialect for the life
 * of the connection.
 *
 * A new holder sends HELLO the instant a server connects, so the server learns
 * the dialect immediately instead of guessing from a timeout.
 */

import { type Bytes, type DecodedFrame, encodeFrame } from './proto/frame';

/** Bumped only on a breaking change to the payload encodings above. */
export const HOLDER_PROTO_VERSION = 2;

export const HolderKind = {
  INPUT: 1,
  RESIZE: 2,
  KILL: 3,
  HELLO: 4,
  OUTPUT: 5,
  EXIT: 6,
  CWD: 7,
  /**
   * "Read your shell's cwd from the kernel and answer with CWD."
   *
   * The live cwd used to move only on an OSC 7 report from the prompt, or on the
   * kernel read a holder does when a client attaches. A shell whose prompt does
   * not emit OSC 7 therefore left the git and file features pinned to the
   * directory the session started in, however much the user `cd`-ed. Asking is
   * cheap — a unix-socket round trip and one `/proc` read — and unlike OSC 7 it
   * works mid-TUI, with no cooperation from the shell.
   *
   * A pre-v2 holder has never heard of this kind and simply ignores it, which is
   * why the caller must not require an answer.
   */
  CWDREQ: 8,
} as const;

/** `{` — the first byte of every legacy newline-JSON frame, and of no binary one. */
export const LEGACY_FIRST_BYTE = 0x7b;

export type HolderDialect = 'legacy' | 'binary';

/** Which dialect a peer is speaking, from the first byte it sent. */
export function sniffDialect(firstByte: number): HolderDialect {
  return firstByte === LEGACY_FIRST_BYTE ? 'legacy' : 'binary';
}

export type HolderMessage =
  | { type: 'input'; data: Uint8Array }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' }
  | { type: 'hello'; version: number }
  | { type: 'output'; data: Uint8Array }
  | { type: 'exit'; exitCode?: number }
  | { type: 'cwd'; cwd: string }
  | { type: 'cwdRequest' };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function encodeHolderInput(text: string | Uint8Array): Bytes {
  return encodeFrame(HolderKind.INPUT, typeof text === 'string' ? encoder.encode(text) : text);
}

export function encodeHolderResize(cols: number, rows: number): Bytes {
  const payload = new Uint8Array(4);
  const view = new DataView(payload.buffer);
  view.setUint16(0, clampU16(cols), false);
  view.setUint16(2, clampU16(rows), false);
  return encodeFrame(HolderKind.RESIZE, payload);
}

export function encodeHolderKill(): Bytes {
  return encodeFrame(HolderKind.KILL);
}

export function encodeHolderHello(version: number = HOLDER_PROTO_VERSION): Bytes {
  return encodeFrame(HolderKind.HELLO, new Uint8Array([version & 0xff]));
}

export function encodeHolderOutput(data: Uint8Array): Bytes {
  return encodeFrame(HolderKind.OUTPUT, data);
}

/** An empty payload means "exited with no code" (killed by signal). */
export function encodeHolderExit(exitCode?: number | null): Bytes {
  if (exitCode === undefined || exitCode === null) return encodeFrame(HolderKind.EXIT);
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setInt32(0, exitCode | 0, false);
  return encodeFrame(HolderKind.EXIT, payload);
}

export function encodeHolderCwd(cwd: string): Bytes {
  return encodeFrame(HolderKind.CWD, encoder.encode(cwd));
}

export function encodeHolderCwdRequest(): Bytes {
  return encodeFrame(HolderKind.CWDREQ);
}

/** Decodes one framed holder message. Unknown kinds decode to null (forward
 *  compatibility: a newer peer may send kinds this build has never heard of). */
export function decodeHolderFrame(frame: DecodedFrame): HolderMessage | null {
  switch (frame.kind) {
    case HolderKind.INPUT:
      return { type: 'input', data: frame.payload };
    case HolderKind.RESIZE: {
      if (frame.payload.byteLength < 4) return null;
      const view = viewOf(frame.payload);
      return { type: 'resize', cols: view.getUint16(0, false), rows: view.getUint16(2, false) };
    }
    case HolderKind.KILL:
      return { type: 'kill' };
    case HolderKind.HELLO:
      return { type: 'hello', version: frame.payload[0] ?? 0 };
    case HolderKind.OUTPUT:
      return { type: 'output', data: frame.payload };
    case HolderKind.EXIT:
      return frame.payload.byteLength >= 4
        ? { type: 'exit', exitCode: viewOf(frame.payload).getInt32(0, false) }
        : { type: 'exit' };
    case HolderKind.CWD:
      return { type: 'cwd', cwd: decoder.decode(frame.payload) };
    case HolderKind.CWDREQ:
      return { type: 'cwdRequest' };
    default:
      return null;
  }
}

/**
 * Decodes one legacy newline-JSON frame body (no trailing newline).
 *
 * Kept in this module, not in the call sites, so the old dialect has exactly one
 * reader and can be deleted in one edit once no pre-v2 holder can still be alive.
 */
export function decodeLegacyHolderLine(line: string): HolderMessage | null {
  let msg: { t?: string; d?: string; c?: number; r?: number; code?: number };
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  switch (msg.t) {
    case 'i':
      return { type: 'input', data: Buffer.from(msg.d ?? '', 'base64') };
    case 'r':
      return { type: 'resize', cols: Number(msg.c), rows: Number(msg.r) };
    case 'k':
      return { type: 'kill' };
    case 'o':
      return msg.d ? { type: 'output', data: Buffer.from(msg.d, 'base64') } : null;
    case 'x':
      return { type: 'exit', exitCode: msg.code };
    case 'c':
      return msg.d ? { type: 'cwd', cwd: msg.d } : null;
    default:
      return null;
  }
}

/** Encodes a message in the legacy dialect, for talking to a pre-v2 holder. */
export function encodeLegacyHolderFrame(msg: HolderMessage): string | null {
  switch (msg.type) {
    case 'input':
      return `${JSON.stringify({ t: 'i', d: Buffer.from(msg.data).toString('base64') })}\n`;
    case 'resize':
      return `${JSON.stringify({ t: 'r', c: msg.cols, r: msg.rows })}\n`;
    case 'kill':
      return `${JSON.stringify({ t: 'k' })}\n`;
    default:
      // The server never sends the holder->server kinds, and a pre-v2 holder has
      // no HELLO. Nothing else is expressible in the old dialect.
      return null;
  }
}

/** Splits a legacy stream into complete lines, returning the unconsumed tail. */
export function takeLegacyLines(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buf;
  let nl = rest.indexOf('\n');
  while (nl !== -1) {
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    nl = rest.indexOf('\n');
    if (line) lines.push(line);
  }
  return { lines, rest };
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function clampU16(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(0xffff, Math.trunc(n)));
}
