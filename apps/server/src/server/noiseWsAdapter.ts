import type { FrameIO } from './noiseChannel';

/** The one method WsFrameIO needs off a hono/bun WSContext to push bytes out. */
export interface WsSender {
  send(data: Uint8Array): void;
}

/**
 * Normalize a hono/bun WS `onMessage` payload into an owned `Uint8Array`.
 *
 * Bun delivers a binary WS frame as an `ArrayBuffer` (and, in some builds, a
 * `Buffer`/typed-array view); a text frame arrives as a `string`. Noise frames
 * are always binary, so a text frame is a protocol error and returns `null`. A
 * typed-array view is copied so the returned bytes are not aliased to a shared,
 * possibly-recycled backing buffer.
 */
export function toFrameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return null;
}

interface Waiter {
  resolve: (frame: Uint8Array) => void;
  reject: (err: Error) => void;
}

/**
 * Adapts a callback-style hono/bun WebSocket into the pull-based `FrameIO` the
 * Noise channel consumes. `push` is fed from the socket's `onMessage`; `recv`
 * pulls the next frame, awaiting one when the queue is empty; `send` writes back
 * out the socket. `close` fails any pending/future `recv` so a handshake or
 * session loop unwinds instead of hanging when the socket drops.
 *
 * Overflow policy: a Noise transport cannot tolerate a dropped or reordered
 * frame — losing one desyncs the cipher for every frame after it — so a queue
 * that grows past `maxQueue` (default 1024) is treated as fatal: the adapter
 * closes and the channel is torn down, rather than silently dropping frames.
 */
export class WsFrameIO implements FrameIO {
  private queue: Uint8Array[] = [];
  private waiters: Waiter[] = [];
  private closedErr: Error | null = null;

  constructor(
    private ws: WsSender,
    private maxQueue = 1024,
  ) {}

  /** Enqueue a frame received from the socket, or hand it to a waiting `recv`. */
  push(bytes: Uint8Array): void {
    if (this.closedErr) return; // frames after close are dropped
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(bytes);
      return;
    }
    if (this.queue.length >= this.maxQueue) {
      this.close(new Error('WsFrameIO: receive queue overflow'));
      return;
    }
    this.queue.push(bytes);
  }

  recv(): Promise<Uint8Array> {
    const frame = this.queue.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise<Uint8Array>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  send(frame: Uint8Array): void {
    this.ws.send(frame);
  }

  /** Close the adapter, rejecting every pending (and any future) `recv`. */
  close(err: Error = new Error('WsFrameIO closed')): void {
    if (this.closedErr) return;
    this.closedErr = err;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
  }

  get closed(): boolean {
    return this.closedErr !== null;
  }
}
