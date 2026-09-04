export type RpcClientMessage =
  | {
      t: 'req';
      id: number;
      method: string;
      path: string;
      headers: Record<string, string>;
      hasBody: boolean;
    }
  | { t: 'req.body'; id: number; seq: number; b64: string }
  | { t: 'req.end'; id: number }
  | { t: 'req.cancel'; id: number };

export type RpcServerMessage =
  | { t: 'res'; id: number; status: number; headers: Record<string, string> }
  | { t: 'res.body'; id: number; seq: number; b64: string }
  | { t: 'res.end'; id: number }
  | { t: 'res.error'; id: number; message: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CLIENT_TYPES = new Set(['req', 'req.body', 'req.end', 'req.cancel']);
const SERVER_TYPES = new Set(['res', 'res.body', 'res.end', 'res.error']);

export function encodeMessage(msg: RpcClientMessage | RpcServerMessage): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

function parse(bytes: Uint8Array): Record<string, unknown> {
  const value = JSON.parse(decoder.decode(bytes));
  if (typeof value !== 'object' || value === null) throw new Error('rpc: not an object');
  return value as Record<string, unknown>;
}

export function decodeClientMessage(bytes: Uint8Array): RpcClientMessage {
  const value = parse(bytes);
  if (typeof value.t !== 'string' || !CLIENT_TYPES.has(value.t)) {
    throw new Error(`rpc: unknown client message '${String(value.t)}'`);
  }
  return value as unknown as RpcClientMessage;
}

export function decodeServerMessage(bytes: Uint8Array): RpcServerMessage {
  const value = parse(bytes);
  if (typeof value.t !== 'string' || !SERVER_TYPES.has(value.t)) {
    throw new Error(`rpc: unknown server message '${String(value.t)}'`);
  }
  return value as unknown as RpcServerMessage;
}

export const MAX_RPC_CHUNK_BYTES = 48 * 1024;

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function chunkBody<T>(bytes: Uint8Array, make: (seq: number, b64: string) => T[]): T[] {
  const out: T[] = [];
  let seq = 0;
  for (let i = 0; i < bytes.length; i += MAX_RPC_CHUNK_BYTES) {
    const slice = bytes.subarray(i, i + MAX_RPC_CHUNK_BYTES);
    out.push(...make(seq, toB64(slice)));
    seq += 1;
  }
  return out;
}

// The ONLY paths a paired device may reach over the tunnel. Everything else
// (config, admin, setup, status, noise/*, preview) is refused before dispatch.
const ALLOW_PREFIXES = ['/api/sessions', '/api/presentations', '/api/push/'];

export function isTunnelablePath(path: string): boolean {
  // Normalize away any traversal, then compare the pathname only.
  const clean = new URL(path, 'https://noise.local').pathname;
  return ALLOW_PREFIXES.some(
    (p) => clean === p || clean.startsWith(`${p}/`) || clean.startsWith(p),
  );
}

import type { FrameIO, ServerChannel } from './noiseChannel';

export interface RpcDeps {
  dispatch: (req: Request) => Promise<Response>;
  identity: { deviceId: string };
  maxInFlight?: number;
}

interface Pending {
  method: string;
  path: string;
  headers: Record<string, string>;
  hasBody: boolean;
  chunks: Uint8Array[];
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function runNoiseRpc(
  channel: ServerChannel,
  io: FrameIO,
  deps: RpcDeps,
): Promise<void> {
  const maxInFlight = deps.maxInFlight ?? 32;
  const pending = new Map<number, Pending>();
  let inFlight = 0;

  const send = (msg: RpcServerMessage) => {
    try {
      void io.send(channel.seal(encodeMessage(msg)));
    } catch {
      // A seal/send failure means the channel is unusable; the recv loop below
      // will observe the close and unwind.
    }
  };

  const dispatchRequest = async (id: number, p: Pending) => {
    if (!isTunnelablePath(p.path)) {
      send({ t: 'res', id, status: 403, headers: {} });
      send({ t: 'res.end', id });
      inFlight -= 1;
      return;
    }
    try {
      const total = p.chunks.reduce((n, c) => n + c.length, 0);
      const body = total > 0 ? new Blob(p.chunks as BlobPart[]) : undefined;
      const req = new Request(`https://noise.local${p.path}`, {
        method: p.method,
        headers: p.headers,
        body,
      });
      const res = await deps.dispatch(req);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      send({ t: 'res', id, status: res.status, headers });
      const bytes = new Uint8Array(await res.arrayBuffer());
      for (const frame of chunkBody(bytes, (seq, b64) => [
        { t: 'res.body' as const, id, seq, b64 },
      ])) {
        send(frame);
      }
      send({ t: 'res.end', id });
    } catch (err) {
      send({ t: 'res.error', id, message: err instanceof Error ? err.message : 'dispatch failed' });
    } finally {
      inFlight -= 1;
    }
  };

  const begin = (id: number, p: Pending) => {
    inFlight += 1;
    void dispatchRequest(id, p);
  };

  try {
    for (;;) {
      const msg = decodeClientMessage(channel.open(await io.recv()));
      if (msg.t === 'req') {
        if (inFlight >= maxInFlight) {
          send({ t: 'res', id: msg.id, status: 503, headers: {} });
          send({ t: 'res.end', id: msg.id });
          continue;
        }
        const p: Pending = {
          method: msg.method,
          path: msg.path,
          headers: msg.headers,
          hasBody: msg.hasBody,
          chunks: [],
        };
        if (msg.hasBody) {
          pending.set(msg.id, p);
        } else {
          begin(msg.id, p);
        }
      } else if (msg.t === 'req.body') {
        pending.get(msg.id)?.chunks.push(fromB64(msg.b64));
      } else if (msg.t === 'req.end') {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (p) begin(msg.id, p);
      } else if (msg.t === 'req.cancel') {
        pending.delete(msg.id);
      }
    }
  } catch {
    // io.recv() rejected (channel closed) or a decrypt/parse failure — end.
  }
}
