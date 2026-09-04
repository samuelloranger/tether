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
  return ALLOW_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`) || clean.startsWith(p));
}
