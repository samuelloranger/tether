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

import type { FrameIO, ServerChannel } from './noiseChannel';
import { runNoiseRpc } from './noiseRpc';

// A pass-through "channel": seal/open are identity so the test can read frames
// as plaintext. Mirrors how noiseSessionProtocol tests fake the channel.
function fakeChannel(): ServerChannel {
  return { seal: (b: Uint8Array) => b, open: (b: Uint8Array) => b } as unknown as ServerChannel;
}

function fakeIO() {
  const inbound: Uint8Array[] = [];
  const outbound: Uint8Array[] = [];
  const waiters: ((f: Uint8Array) => void)[] = [];
  let closed: Error | null = null;
  return {
    io: {
      send(frame: Uint8Array) {
        outbound.push(frame);
      },
      recv(): Promise<Uint8Array> {
        const f = inbound.shift();
        if (f) return Promise.resolve(f);
        if (closed) return Promise.reject(closed);
        return new Promise((res) => waiters.push(res));
      },
    } as FrameIO,
    push(frame: Uint8Array) {
      const w = waiters.shift();
      if (w) w(frame);
      else inbound.push(frame);
    },
    close() {
      closed = new Error('closed');
    },
    outbound,
  };
}

test('runNoiseRpc dispatches a GET and streams the response back', async () => {
  const { io, push, close, outbound } = fakeIO();
  const dispatch = async (req: Request) => {
    expect(req.method).toBe('GET');
    expect(new URL(req.url).pathname).toBe('/api/sessions');
    return new Response(JSON.stringify([{ id: 'term-1' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const loop = runNoiseRpc(fakeChannel(), io, { dispatch, identity: { deviceId: 'dev-1' } });

  push(
    encodeMessage({
      t: 'req',
      id: 1,
      method: 'GET',
      path: '/api/sessions',
      headers: {},
      hasBody: false,
    }),
  );
  push(encodeMessage({ t: 'req.end', id: 1 }));
  await new Promise((r) => setTimeout(r, 20));
  close();
  push(encodeMessage({ t: 'req.cancel', id: 999 }));
  await loop;

  const msgs = outbound.map((f) => decodeServerMessage(f));
  const res = msgs.find((m) => m.t === 'res');
  const bodies = msgs.filter((m) => m.t === 'res.body');
  const end = msgs.find((m) => m.t === 'res.end');
  expect(res).toMatchObject({ id: 1, status: 200 });
  expect(end).toMatchObject({ id: 1 });
  const text = bodies.map((b) => atob((b as { b64: string }).b64)).join('');
  expect(JSON.parse(text)).toEqual([{ id: 'term-1' }]);
});

test('runNoiseRpc refuses a disallowed path with 403 and does not dispatch', async () => {
  const { io, push, close, outbound } = fakeIO();
  let dispatched = false;
  const dispatch = async () => {
    dispatched = true;
    return new Response('', { status: 200 });
  };
  const loop = runNoiseRpc(fakeChannel(), io, { dispatch, identity: { deviceId: 'dev-1' } });
  push(
    encodeMessage({
      t: 'req',
      id: 7,
      method: 'PATCH',
      path: '/api/config',
      headers: {},
      hasBody: false,
    }),
  );
  push(encodeMessage({ t: 'req.end', id: 7 }));
  await new Promise((r) => setTimeout(r, 20));
  close();
  push(encodeMessage({ t: 'req.cancel', id: 999 }));
  await loop;
  expect(dispatched).toBe(false);
  const res = outbound.map((f) => decodeServerMessage(f)).find((m) => m.t === 'res');
  expect(res).toMatchObject({ id: 7, status: 403 });
});
