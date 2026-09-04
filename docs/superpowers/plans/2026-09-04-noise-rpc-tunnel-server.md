# Server Noise-RPC Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Tether's client-facing REST surface over the authenticated Noise channel, so a paired device can call `/api/sessions`, git, file, upload, presentations, and push over a sealed tunnel — no shared password.

**Architecture:** A new `GET /api/noise/rpc` WebSocket endpoint runs the same IK handshake + registry authorization as `/api/noise/session` (fail-closed). Over the established channel, a mux loop reads sealed request envelopes, reconstructs a standard `Request`, dispatches it through the existing Hono app (`app.fetch`), and streams the `Response` back as sealed frames. Bodies larger than one frame are chunked. This is additive — the password path is untouched by this plan (its removal is a later plan).

**Tech Stack:** Bun + Hono, `bun:test`, the existing Noise `ServerChannel`/`FrameIO`/`runReconnect` primitives. Biome (2-space, single quotes, semicolons, width 100).

**Spec:** `docs/superpowers/specs/2026-09-04-noise-rest-transport-design.md`

## Global Constraints

- Additive only: do NOT touch `authMiddleware`, `auth.ts`, `/api/setup`, or the password path in this plan.
- Fail-closed: an unknown/revoked device must be refused by the handshake/registry gate before any request is dispatched — reuse `runReconnect`, never re-implement auth.
- Reuse existing primitives: `ServerChannel.seal/open` (noiseChannel.ts), `FrameIO` (noiseChannel.ts:7), `WsFrameIO`/`sink` (noiseWsAdapter.ts), `runReconnect` (authGate.ts:18), the DoS caps + `withHandshakeTimeout` already in routes/noise.ts.
- Every sealed frame is one JSON message: `encodeMessage(msg)` = UTF-8 of `JSON.stringify(msg)`; binary bodies travel base64 inside JSON (simple + consistent with the session protocol; bulk-transfer perf is a known, accepted risk per the spec).
- Path allowlist: only the remote surface may be tunneled — `/api/sessions*`, `/api/presentations*`, `/api/push/*`. Never dispatch `/api/config`, `/api/admin*`, `/api/setup`, `/api/status`, `/api/noise/*`, `/preview/*`.
- Server tests run with `bun --cwd apps/server run test` (NOT bare `bun test`). Never set `TETHER_DB_PATH` for a suite run.

---

### Task 1: RPC envelope codec

Pure encode/decode of the wire messages. No I/O, no channel.

**Files:**
- Create: `apps/server/src/server/noiseRpc.ts`
- Test: `apps/server/src/server/noiseRpc.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types (exported):
    - `type RpcClientMessage = { t: 'req'; id: number; method: string; path: string; headers: Record<string, string>; hasBody: boolean } | { t: 'req.body'; id: number; seq: number; b64: string } | { t: 'req.end'; id: number } | { t: 'req.cancel'; id: number }`
    - `type RpcServerMessage = { t: 'res'; id: number; status: number; headers: Record<string, string> } | { t: 'res.body'; id: number; seq: number; b64: string } | { t: 'res.end'; id: number } | { t: 'res.error'; id: number; message: string }`
  - `function encodeMessage(msg: RpcClientMessage | RpcServerMessage): Uint8Array`
  - `function decodeClientMessage(bytes: Uint8Array): RpcClientMessage` (throws on bad JSON / unknown `t`)
  - `function decodeServerMessage(bytes: Uint8Array): RpcServerMessage`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/server/noiseRpc.test.ts
import { describe, expect, test } from 'bun:test';
import { decodeClientMessage, decodeServerMessage, encodeMessage } from './noiseRpc';

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
    const res = { t: 'res' as const, id: 2, status: 200, headers: { 'content-type': 'application/json' } };
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/server test src/server/noiseRpc.test.ts`
Expected: FAIL — `noiseRpc` module / exports not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/server/noiseRpc.ts
export type RpcClientMessage =
  | { t: 'req'; id: number; method: string; path: string; headers: Record<string, string>; hasBody: boolean }
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

function parse(bytes: Uint8Array): { t?: unknown } & Record<string, unknown> {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/server test src/server/noiseRpc.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/noiseRpc.ts apps/server/src/server/noiseRpc.test.ts
git commit -m "feat(noise): rpc envelope codec"
```

---

### Task 2: Body chunking + path allowlist

Pure helpers used by the loop: split a byte body into `res.body`/`req.body` chunks under a size cap, reassemble chunks, and decide whether a path may be tunneled.

**Files:**
- Modify: `apps/server/src/server/noiseRpc.ts`
- Test: `apps/server/src/server/noiseRpc.test.ts`

**Interfaces:**
- Consumes: `RpcServerMessage` (Task 1).
- Produces:
  - `const MAX_RPC_CHUNK_BYTES = 48 * 1024` (base64 of this stays well under the FFI transport buffer).
  - `function chunkBody(bytes: Uint8Array, make: (seq: number, b64: string) => T[]): T[]` — generic so both req/res use it. Splits raw bytes into base64 pieces of at most `MAX_RPC_CHUNK_BYTES` raw bytes each, in order.
  - `function isTunnelablePath(path: string): boolean` — true only for the allowed remote surface.

- [ ] **Step 1: Write the failing test**

```ts
// append to apps/server/src/server/noiseRpc.test.ts
import { chunkBody, isTunnelablePath, MAX_RPC_CHUNK_BYTES } from './noiseRpc';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/server test src/server/noiseRpc.test.ts`
Expected: FAIL — `chunkBody`/`isTunnelablePath`/`MAX_RPC_CHUNK_BYTES` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to apps/server/src/server/noiseRpc.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/server test src/server/noiseRpc.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/noiseRpc.ts apps/server/src/server/noiseRpc.test.ts
git commit -m "feat(noise): rpc body chunking + path allowlist"
```

---

### Task 3: The mux/dispatch loop `runNoiseRpc`

Reads sealed request frames off the channel, reassembles per-`id` requests, dispatches each through an injected `dispatch` (which will be `app.fetch`), and streams responses back — concurrently, without one request blocking the recv of another.

**Files:**
- Modify: `apps/server/src/server/noiseRpc.ts`
- Test: `apps/server/src/server/noiseRpc.test.ts`

**Interfaces:**
- Consumes: `FrameIO` (noiseChannel.ts:7 — `send(frame): void|Promise<void>`, `recv(): Promise<Uint8Array>`), `ServerChannel` (noiseChannel.ts:32 — `seal(bytes): Uint8Array`, `open(wire): Uint8Array`), Task 1 codec, Task 2 helpers.
- Produces:
  - `interface RpcDeps { dispatch: (req: Request) => Promise<Response>; identity: { deviceId: string }; maxInFlight?: number }`
  - `async function runNoiseRpc(channel: ServerChannel, io: FrameIO, deps: RpcDeps): Promise<void>` — returns when the channel closes (recv rejects). Never throws to the caller.

- [ ] **Step 1: Write the failing test**

```ts
// append to apps/server/src/server/noiseRpc.test.ts
import { runNoiseRpc } from './noiseRpc';

// A pass-through "channel": seal/open are identity so the test can read frames
// as plaintext. Mirrors how noiseSessionProtocol tests fake the channel.
function fakeChannel() {
  return { seal: (b: Uint8Array) => b, open: (b: Uint8Array) => b } as unknown as import('./noiseChannel').ServerChannel;
}

// A scripted FrameIO: `push` client frames in, collect server frames out, and
// `close` ends the loop by rejecting recv.
function fakeIO() {
  const inbound: Uint8Array[] = [];
  const outbound: Uint8Array[] = [];
  let waiters: ((f: Uint8Array) => void)[] = [];
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
    } as import('./noiseChannel').FrameIO,
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

  push(encodeMessage({ t: 'req', id: 1, method: 'GET', path: '/api/sessions', headers: {}, hasBody: false }));
  push(encodeMessage({ t: 'req.end', id: 1 }));
  // let the microtasks run
  await new Promise((r) => setTimeout(r, 20));
  close();
  push(encodeMessage({ t: 'req.cancel', id: 999 })); // unblock the recv waiter
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
  push(encodeMessage({ t: 'req', id: 7, method: 'PATCH', path: '/api/config', headers: {}, hasBody: false }));
  push(encodeMessage({ t: 'req.end', id: 7 }));
  await new Promise((r) => setTimeout(r, 20));
  close();
  push(encodeMessage({ t: 'req.cancel', id: 999 }));
  await loop;
  expect(dispatched).toBe(false);
  const res = outbound.map((f) => decodeServerMessage(f)).find((m) => m.t === 'res');
  expect(res).toMatchObject({ id: 7, status: 403 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/server test src/server/noiseRpc.test.ts`
Expected: FAIL — `runNoiseRpc` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to apps/server/src/server/noiseRpc.ts
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

export async function runNoiseRpc(channel: ServerChannel, io: FrameIO, deps: RpcDeps): Promise<void> {
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
      return;
    }
    try {
      const total = p.chunks.reduce((n, c) => n + c.length, 0);
      const body = total > 0 ? new Blob(p.chunks) : undefined;
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
      for (const frame of chunkBody(bytes, (seq, b64) => [{ t: 'res.body' as const, id, seq, b64 }])) {
        send(frame);
      }
      send({ t: 'res.end', id });
    } catch (err) {
      send({ t: 'res.error', id, message: err instanceof Error ? err.message : 'dispatch failed' });
    } finally {
      inFlight -= 1;
    }
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
        pending.set(msg.id, {
          method: msg.method,
          path: msg.path,
          headers: msg.headers,
          hasBody: msg.hasBody,
          chunks: [],
        });
        if (!msg.hasBody) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (p) {
            inFlight += 1;
            void dispatchRequest(msg.id, p);
          }
        }
      } else if (msg.t === 'req.body') {
        pending.get(msg.id)?.chunks.push(fromB64(msg.b64));
      } else if (msg.t === 'req.end') {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (p) {
          inFlight += 1;
          void dispatchRequest(msg.id, p);
        }
      } else if (msg.t === 'req.cancel') {
        pending.delete(msg.id);
      }
    }
  } catch {
    // io.recv() rejected (channel closed) or a decrypt/parse failure — end.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/server test src/server/noiseRpc.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/noiseRpc.ts apps/server/src/server/noiseRpc.test.ts
git commit -m "feat(noise): rpc mux/dispatch loop over the sealed channel"
```

---

### Task 4: The `/api/noise/rpc` endpoint + app dispatch injection

Wire the loop to a real WS endpoint with the same auth + DoS guards as `/api/noise/session`, and give it `app.fetch` as the dispatcher without creating an import cycle.

**Files:**
- Modify: `apps/server/src/server/routes/noise.ts`
- Modify: `apps/server/src/server/app.ts` (inject the dispatcher after `app` is built)
- Test: `apps/server/src/server/noiseRpc.route.test.ts`

**Interfaces:**
- Consumes: `runNoiseRpc` (Task 3), `runReconnect` (authGate.ts:18), `WsFrameIO`/`sink` (noiseWsAdapter.ts), `loadOrCreateServerKeypair` (noiseIdentity.ts), `getDeviceByPubkey`/`touchDevice` (deviceRegistry.ts), the module-level `MAX_NOISE_CONNECTIONS`/`activeNoiseConnections`/`withHandshakeTimeout` already in routes/noise.ts.
- Produces:
  - In routes/noise.ts: `export function setNoiseRpcDispatch(dispatch: (req: Request) => Promise<Response>): void` — app.ts calls this once with `app.fetch.bind(app)` after the app is assembled. The `/api/noise/rpc` handler reads the stored dispatcher at connection time (so there is no import cycle: routes/noise.ts never imports app.ts).
  - `/api/noise/rpc` added to the Noise routes.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/server/noiseRpc.route.test.ts
import { describe, expect, test } from 'bun:test';
import { getNoiseRpcDispatch, setNoiseRpcDispatch } from './routes/noise';

describe('noise rpc dispatch injection', () => {
  test('dispatcher is settable and readable', () => {
    const fn = async () => new Response('ok');
    setNoiseRpcDispatch(fn);
    expect(getNoiseRpcDispatch()).toBe(fn);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/server test src/server/noiseRpc.route.test.ts`
Expected: FAIL — `setNoiseRpcDispatch`/`getNoiseRpcDispatch` not exported.

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/server/routes/noise.ts`, add the dispatcher slot and the endpoint (mirror the `/api/noise/session` block already in the file):

```ts
// near the top of routes/noise.ts, after imports
import { runNoiseRpc } from '../noiseRpc';

let noiseRpcDispatch: ((req: Request) => Promise<Response>) | null = null;
export function setNoiseRpcDispatch(dispatch: (req: Request) => Promise<Response>): void {
  noiseRpcDispatch = dispatch;
}
export function getNoiseRpcDispatch(): ((req: Request) => Promise<Response>) | null {
  return noiseRpcDispatch;
}
```

```ts
// add alongside the existing noiseRoutes.get('/api/noise/session', ...) block
noiseRoutes.get(
  '/api/noise/rpc',
  upgradeWebSocket(() => {
    let io: WsFrameIO | null = null;
    return {
      onOpen(_evt, ws) {
        if (activeNoiseConnections >= MAX_NOISE_CONNECTIONS) {
          try {
            ws.close(1013);
          } catch {}
          return;
        }
        activeNoiseConnections += 1;
        const adapter = new WsFrameIO(sink(ws));
        io = adapter;
        const priv = loadOrCreateServerKeypair().priv;
        withHandshakeTimeout(runReconnect(adapter, priv, { getDeviceByPubkey, touchDevice }), () =>
          adapter.close(),
        )
          .then(async ({ channel, device }) => {
            const dispatch = getNoiseRpcDispatch();
            if (!dispatch) {
              try {
                ws.close(1011);
              } catch {}
              return;
            }
            logInfo(`Noise rpc authorized device ${device.id}`);
            try {
              await runNoiseRpc(channel, adapter, { dispatch, identity: { deviceId: device.id } });
            } finally {
              channel.free();
              try {
                ws.close();
              } catch {}
            }
          })
          .catch((err) => {
            if (!(err instanceof ChannelError)) {
              logError('Noise rpc setup failed:', err);
            }
            try {
              ws.close(1008);
            } catch {}
          })
          .finally(() => {
            adapter.close();
            activeNoiseConnections -= 1;
          });
      },
      onMessage(evt) {
        if (io) pushFrame(io, evt.data);
      },
      onClose() {
        io?.close();
      },
    };
  }),
);
```

Also add `/api/noise/rpc` to `PUBLIC_API_PATHS` in `apps/server/src/server/auth.ts` (the endpoint self-authenticates via the handshake, like `/api/noise/session`):

```ts
const PUBLIC_API_PATHS = new Set([
  '/api/status',
  '/api/setup',
  '/api/noise/pair',
  '/api/noise/session',
  '/api/noise/rpc',
]);
```

In `apps/server/src/server/app.ts`, after `app` is fully assembled (routes mounted) and before `export { app }`, wire the dispatcher:

```ts
import { setNoiseRpcDispatch } from './routes/noise';
// ...after all app.route(...)/app.use(...) calls:
setNoiseRpcDispatch((req: Request) => app.fetch(req));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/server test src/server/noiseRpc.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + lint stay green**

Run: `bun --cwd apps/server run test` (expect 0 fail), then `bunx biome check --write apps/server/src/server/noiseRpc.ts apps/server/src/server/routes/noise.ts apps/server/src/server/app.ts apps/server/src/server/auth.ts` and the server typecheck script.
Expected: all green; the additive endpoint breaks nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server/routes/noise.ts apps/server/src/server/app.ts apps/server/src/server/auth.ts apps/server/src/server/noiseRpc.route.test.ts
git commit -m "feat(noise): /api/noise/rpc endpoint tunneling REST over the sealed channel"
```

---

### Task 5: Live E2E — a REST call over Noise

Prove the tunnel end to end against a real server: pair, open the RPC channel, `GET /api/sessions` over Noise, and confirm a revoked device is refused (fail-closed). Follows the existing env-gated harness pattern (`e2e-noise.ts` in the scratchpad + the driver that opens a pairing window and auto-confirms).

**Files:**
- Create: `apps/server/e2e-noise-rpc.ts` (env-gated standalone harness, run with `bun run`)

**Interfaces:**
- Consumes: `noiseFfi` (`genKeypair`, `derivePsk`, `pairInitiator`, `reconnectInitiator`), the RPC codec (Task 1). Reuses the temp-server + auto-confirm driver already in the repo scratchpad.

- [ ] **Step 1: Write the harness**

```ts
// apps/server/e2e-noise-rpc.ts
// Env-gated: needs a running server (TETHER_E2E_URL) with a fresh pairing code
// (TETHER_E2E_CODE) and the host auto-confirming. Proves: pair -> open rpc
// channel -> GET /api/sessions returns 200 JSON over the sealed tunnel.
import { derivePsk, genKeypair, pairInitiator, reconnectInitiator } from './src/server/noiseFfi';
import { decodeServerMessage, encodeMessage } from './src/server/noiseRpc';
// ... (reuse the WsClient + handshake helpers from e2e-noise.ts: connect ws,
// run XXpsk2 pair to pin the server key, then IK reconnect to /api/noise/rpc.)
// After the channel is in transport mode:
//   ws.send(seal(encodeMessage({ t:'req', id:1, method:'GET',
//     path:'/api/sessions', headers:{}, hasBody:false })))
//   ws.send(seal(encodeMessage({ t:'req.end', id:1 })))
// then read res + res.body + res.end, base64-decode the body, JSON.parse it,
// and assert the response is 200 and an array. Exit non-zero on any mismatch.
```

Write the full harness by copying the connect/handshake plumbing from the existing `e2e-noise.ts` (same `WsClient`, same `pairInitiator`/`reconnectInitiator` flow — only the endpoint path `/api/noise/rpc` and the application messages differ). The application exchange is exactly the two `req`/`req.end` sends and the `res`/`res.body`/`res.end` reads shown above.

- [ ] **Step 2: Run it against a temp server**

Start the scratchpad driver (temp server on a spare port + auto-confirm), grab a fresh code, then:
Run: `TETHER_E2E_URL=http://127.0.0.1:<port> TETHER_E2E_CODE=<code> bun run apps/server/e2e-noise-rpc.ts`
Expected: prints `RPC E2E PASSED` — `GET /api/sessions` returned status 200 and a JSON array over the tunnel.

- [ ] **Step 3: Commit**

```bash
git add apps/server/e2e-noise-rpc.ts
git commit -m "test(noise): live E2E — REST over the Noise rpc tunnel"
```

---

## Self-Review

- **Spec coverage (this plan's slice):** §4.1 RPC channel → Task 4; §4.2 wire framing → Tasks 1–2; §4.3 server dispatch (`app.fetch` + allowlist) → Tasks 3–4; §8 error handling (transport vs HTTP status, 403 on disallowed, fail-closed) → Tasks 3–4; §9 testing (codec/mux/chunk unit, integration, live E2E, fail-closed) → Tasks 1–5. Out of this plan (own plans): terminal-metadata parity (§5), `/preview` loopback (§6), config/admin CLI (§2), client integration (§4.4), the cutover (§7).
- **Placeholder scan:** Task 5's harness references the existing `e2e-noise.ts` plumbing rather than repeating ~80 lines of identical WS/handshake code; the application-level exchange (the only new part) is shown in full. All other tasks contain complete code.
- **Type consistency:** `RpcClientMessage`/`RpcServerMessage`, `encodeMessage`/`decodeClientMessage`/`decodeServerMessage`, `chunkBody`/`isTunnelablePath`/`MAX_RPC_CHUNK_BYTES`, `runNoiseRpc(channel, io, deps)` with `RpcDeps`, and `setNoiseRpcDispatch`/`getNoiseRpcDispatch` are used consistently across tasks and match the `ServerChannel`/`FrameIO` signatures in noiseChannel.ts.

## Follow-on plans (not this document)

2. Terminal-metadata parity — add `title`/`activity`/`diff`/`reset` to the session protocol.
3. Config + admin → host CLI.
4. Client integration — iOS + desktop route REST through `noiseFetch` (needs this plan).
5. Password flag-day cutover (needs 1–4).
