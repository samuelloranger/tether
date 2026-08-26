/**
 * Length-prefixed binary framing, shared by the protocol v2 WebSocket gateway
 * and the server <-> holder unix socket.
 *
 *     u8  kind
 *     u32 len   (big-endian)
 *     [len bytes payload]
 *
 * Payloads are opaque here: the v2 gateway puts raw PTY bytes behind
 * `FrameKind.OUTPUT` and protobuf behind everything else, and the holder link
 * uses its own tiny encodings (holderFrame.ts). This module only knows how to
 * cut the stream into frames — which is exactly why it is testable without a
 * PTY, a socket, or a database.
 */

export const FRAME_HEADER_BYTES = 5;

/**
 * A frame's bytes. Pinned to an `ArrayBuffer` (never a `SharedArrayBuffer`) so
 * these can be handed straight to `ws.send`/`socket.write` without a cast.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Hard ceiling on one frame's payload. A single TUI repaint can be hundreds of
 * KB, and replay coalesces 200 rows per frame, so this has to be generous — but
 * it must exist: a desynced or hostile peer otherwise makes us allocate on a
 * 4 GB length prefix.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface DecodedFrame {
  kind: number;
  payload: Uint8Array;
}

const EMPTY: Bytes = new Uint8Array(0);

/** Encodes one frame. `kind` must fit in a byte. */
export function encodeFrame(kind: number, payload: Uint8Array = EMPTY): Bytes {
  if (!Number.isInteger(kind) || kind < 0 || kind > 255) {
    throw new RangeError(`frame kind out of range: ${kind}`);
  }
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new RangeError(`frame payload too large: ${payload.byteLength}`);
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  out[0] = kind;
  new DataView(out.buffer, out.byteOffset, FRAME_HEADER_BYTES).setUint32(
    1,
    payload.byteLength,
    false,
  );
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/** Concatenates frames into one write — one syscall instead of N. */
export function concatFrames(frames: Uint8Array[]): Bytes {
  let total = 0;
  for (const f of frames) total += f.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.byteLength;
  }
  return out;
}

/**
 * Streaming decoder. Sockets hand us arbitrary chunk boundaries, so a frame can
 * arrive split across any number of `push` calls (and several frames can arrive
 * in one).
 *
 * Throws on a payload length above `MAX_FRAME_BYTES`: at that point the stream
 * is desynced and there is no honest way to resynchronize, so the caller must
 * drop the connection rather than guess.
 */
export class FrameDecoder {
  private buf: Uint8Array = EMPTY;

  constructor(private readonly maxFrameBytes: number = MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): DecodedFrame[] {
    this.buf = this.buf.byteLength === 0 ? chunk : concatFrames([this.buf, chunk]);
    const frames: DecodedFrame[] = [];
    let at = 0;
    while (this.buf.byteLength - at >= FRAME_HEADER_BYTES) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + at, FRAME_HEADER_BYTES);
      const len = view.getUint32(1, false);
      if (len > this.maxFrameBytes) {
        this.buf = EMPTY;
        throw new RangeError(`frame payload too large: ${len}`);
      }
      const end = at + FRAME_HEADER_BYTES + len;
      if (this.buf.byteLength < end) break;
      frames.push({
        kind: this.buf[at],
        // slice, not subarray: the payload outlives this buffer (it is logged,
        // broadcast, queued) and must not pin the whole read buffer alive.
        payload: this.buf.slice(at + FRAME_HEADER_BYTES, end),
      });
      at = end;
    }
    this.buf = at === 0 ? this.buf : this.buf.slice(at);
    return frames;
  }

  /** Bytes held back waiting for the rest of a frame. */
  get pending(): number {
    return this.buf.byteLength;
  }
}
