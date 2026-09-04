import { describe, expect, test } from 'bun:test';
import {
  chunkBody,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  isTunnelablePath,
  MAX_RPC_CHUNK_BYTES,
} from './noiseRpc';

describe('rpc codec', () => {
  test('req head round-trips', () => {
    const msg = {
      t: 'req' as const,
      id: 1,
      method: 'GET',
      path: '/api/sessions?x=1',
      headers: { accept: 'application/json' },
      hasBody: false,
    };
    expect(decodeClientMessage(encodeMessage(msg))).toEqual(msg);
  });

  test('res + body + end round-trip', () => {
    const res = {
      t: 'res' as const,
      id: 2,
      status: 200,
      headers: { 'content-type': 'application/json' },
    };
    const body = { t: 'res.body' as const, id: 2, seq: 0, b64: btoa('hello') };
    const end = { t: 'res.end' as const, id: 2 };
    expect(decodeServerMessage(encodeMessage(res))).toEqual(res);
    expect(decodeServerMessage(encodeMessage(body))).toEqual(body);
    expect(decodeServerMessage(encodeMessage(end))).toEqual(end);
  });

  test('decode rejects unknown type and bad json', () => {
    expect(() => decodeClientMessage(new TextEncoder().encode('{"t":"nope"}'))).toThrow();
    expect(() => decodeClientMessage(new TextEncoder().encode('not json'))).toThrow();
  });
});

describe('rpc chunking + allowlist', () => {
  test('chunkBody splits over the cap, preserves order + bytes', () => {
    const raw = new Uint8Array(MAX_RPC_CHUNK_BYTES * 2 + 10).map((_, i) => i % 256);
    const chunks = chunkBody(raw, (seq, b64) => [{ seq, b64 }]);
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    const joined = chunks.map((c) => Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0)));
    const total = new Uint8Array(joined.reduce((n, a) => n + a.length, 0));
    let off = 0;
    for (const a of joined) {
      total.set(a, off);
      off += a.length;
    }
    expect(total).toEqual(raw);
  });

  test('allowlist admits the remote surface, refuses the rest', () => {
    expect(isTunnelablePath('/api/sessions')).toBe(true);
    expect(isTunnelablePath('/api/sessions/term-1/diff')).toBe(true);
    expect(isTunnelablePath('/api/presentations')).toBe(true);
    expect(isTunnelablePath('/api/push/register')).toBe(true);
    expect(isTunnelablePath('/api/config')).toBe(false);
    expect(isTunnelablePath('/api/admin/restart')).toBe(false);
    expect(isTunnelablePath('/api/noise/session')).toBe(false);
    expect(isTunnelablePath('/preview/abc/index.html')).toBe(false);
    expect(isTunnelablePath('/api/../api/config')).toBe(false);
  });
});
