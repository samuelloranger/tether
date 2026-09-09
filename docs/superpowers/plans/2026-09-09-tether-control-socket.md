# Tether control-plane unix socket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the daemon's `/control/*` IPC off the public HTTP listener onto a loopback-only unix domain socket, so the local `tether present|signal|pair` CLIs reach the daemon over a filesystem-permissioned socket instead of a network port, and the `X-Tether-Present-Control` token is removed entirely.

**Architecture:** The daemon opens a second listener — `Bun.serve({ unix: CONTROL_SOCK })` — serving a dedicated `controlApp` (Hono) that mounts only the `/control/*` routes. The network `app` (TCP :8085/:8443, Caddy-proxied) stops mounting `/control/*` altogether, so those routes are no longer internet-reachable. The CLIs call `fetch(url, { unix: CONTROL_SOCK })`. Filesystem perms on the socket (`0600`, inside `STATE_DIR` `0700`) replace the shared token.

**Tech Stack:** Bun 1.4.x, Hono, bun:test. Reuses the proven AF_UNIX pattern from `holder.ts` (`Bun.listen({ unix })`); spike confirmed `Bun.serve({ unix })` + `fetch({ unix })` round-trips.

**Spec:** `docs/superpowers/specs/2026-09-09-tether-control-plane-and-preview-auth-design.md` (§4.1)

## Global Constraints

- **Runtime floor:** Bun ≥ 1.3.14 (PTY API); dev/CI on 1.4.x. `unix` fetch/serve options are used — both proven in-repo (holder sockets) and by spike.
- **Cross-platform:** the server binary ships to Linux, macOS, **and Windows** (`server-windows` CI on `windows-latest`, `tether-windows-x64.exe`). AF_UNIX works on all three under Bun. Do NOT gate the socket on `process.platform`.
- **Formatting:** Biome — 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before each commit.
- **Tests:** colocated `foo.ts` + `foo.test.ts`, bun:test. Run with `bun --cwd apps/server run test` (NOT bare `bun test`). Never pin `TETHER_DB_PATH`.
- **Comments:** minimal — only non-obvious "why".
- **Paths in this plan are relative to `apps/server/src/server/`** unless stated.
- **No behavior change to the underlying handlers** — `PresentationRegistry.create/reset`, `signalSession`, `pairControl.*` stay byte-for-byte; only transport + auth-gate move.

---

### Task 1: Control socket path + directory/socket permissions helper

**Files:**
- Modify: `paths.ts`
- Create: `controlSocket.ts`
- Test: `controlSocket.test.ts`

**Interfaces:**
- Produces:
  - `CONTROL_SOCK: string` (in `paths.ts`) — `process.env.TETHER_CONTROL_SOCK ?? path.join(STATE_DIR, 'control.sock')`.
  - `prepareControlSocket(sock: string): void` — makes `dirname(sock)` exist with mode `0700` and removes any stale socket file at `sock`. Called before `Bun.serve({ unix })`.
  - `hardenControlSocket(sock: string): void` — `chmod(sock, 0o600)` after the listener is up (no-op-safe if the FS ignores mode, e.g. Windows).

- [ ] **Step 1: Write the failing test**

```ts
// controlSocket.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hardenControlSocket, prepareControlSocket } from './controlSocket';

describe('prepareControlSocket', () => {
  test('creates the socket dir 0700 and removes a stale socket file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-ctl-'));
    const sock = path.join(dir, 'nested', 'control.sock');
    // simulate a stale socket left by a crashed daemon
    prepareControlSocket(sock); // dir must be created first
    writeFileSync(sock, 'stale');
    prepareControlSocket(sock); // must not throw, must unlink the stale file
    expect(() => statSync(sock)).toThrow();
    if (process.platform !== 'win32') {
      expect(statSync(path.dirname(sock)).mode & 0o777).toBe(0o700);
    }
  });

  test('hardenControlSocket does not throw when the socket is absent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tether-ctl-'));
    expect(() => hardenControlSocket(path.join(dir, 'missing.sock'))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/server run test controlSocket`
Expected: FAIL — `Cannot find module './controlSocket'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// controlSocket.ts
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export function prepareControlSocket(sock: string): void {
  mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  // A prior daemon that did not shut down cleanly leaves the socket file behind;
  // Bun.serve refuses to bind an existing path. force:true = no throw if absent.
  rmSync(sock, { force: true });
}

export function hardenControlSocket(sock: string): void {
  // Filesystem perms are the auth here. On a FS that ignores mode (Windows), the
  // socket is already confined to the local machine, so a failure is not fatal.
  try {
    chmodSync(sock, 0o600);
  } catch {
    // ignore
  }
}
```

Add to `paths.ts` (near the other `STATE_DIR`-derived paths):

```ts
export const CONTROL_SOCK =
  process.env.TETHER_CONTROL_SOCK ?? path.join(STATE_DIR, 'control.sock');
```

> Note: `mkdirSync(..., { mode: 0o700 })` is masked by the process umask on some
> systems; the test asserts `0700` which holds under the default `022` umask
> (0777 & ~022 = 0755 would fail, so if CI umask differs, add an explicit
> `chmodSync(dir, 0o700)` after mkdir). Keep the explicit chmod if the assertion
> is flaky.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/server run test controlSocket`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/controlSocket.ts apps/server/src/server/controlSocket.test.ts apps/server/src/server/paths.ts
git commit -m "feat(server): control-socket path + perms helper"
```

---

### Task 2: Assemble the ungated `controlApp` from the existing control routes

Move the `/control/*` handlers into a dedicated Hono app with **no token gate** (the socket is the auth). The `PresentationRegistry` singleton must stay shared with the network app (which still serves `/api/presentations` + `/preview`), so it is hoisted to its own module.

**Files:**
- Create: `presentationRegistry.ts` (hoist the singleton out of `routes/presentations.ts`)
- Create: `controlApp.ts`
- Modify: `routes/presentations.ts` (import the singleton; drop `hasControlToken`/`createControlToken`; move the two `/control/presentations*` handlers out)
- Modify: `routes/signal.ts` (drop the `hasControlToken` gate; export the router for the control app)
- Modify: `pairControl.ts` (drop the `hasControlToken` gate)
- Test: `controlApp.test.ts`

**Interfaces:**
- Consumes: `PresentationRegistry` (from Task's new `presentationRegistry.ts`), `signalSession`, `pairControl`.
- Produces:
  - `presentationRegistry.ts`: `export const presentations = new PresentationRegistry();`
  - `controlApp.ts`: `export const controlApp: Hono` — mounts:
    - `POST /control/presentations`, `POST /control/presentations/reset`
    - `POST /control/signal`
    - `POST /control/pair/open`, `GET /control/pair/pending`, `POST /control/pair/confirm`, `POST /control/pair/close`
  - None of these read `X-Tether-Present-Control`.

- [ ] **Step 1: Write the failing test**

```ts
// controlApp.test.ts
import { describe, expect, test } from 'bun:test';
import { controlApp } from './controlApp';

const post = (path: string, body: unknown) =>
  controlApp.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('controlApp (ungated — socket is the auth)', () => {
  test('rejects a bad presentation entry with 400, not 401', async () => {
    const res = await post('/control/presentations', { entry: '/nope/not-html.txt' });
    // No token header sent; a 401 would mean the token gate is still wired.
    expect(res.status).toBe(400);
  });

  test('signal for an unknown session is 404, not 401', async () => {
    const res = await post('/control/signal', { sessionId: 'ghost', state: 'working' });
    expect(res.status).toBe(404);
  });

  test('pair/open succeeds with no token header', async () => {
    const res = await post('/control/pair/open', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string };
    expect(body.code).toMatch(/^\d{12}$/);
    await post('/control/pair/close', {});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/server run test controlApp`
Expected: FAIL — `Cannot find module './controlApp'`.

- [ ] **Step 3: Write minimal implementation**

Create `presentationRegistry.ts`:

```ts
import { PresentationRegistry } from './presentations';

// Single shared instance: the control app creates/resets previews, the network
// app lists them (/api/presentations) and serves them (/preview).
export const presentations = new PresentationRegistry();
```

In `routes/presentations.ts`: delete the local `const presentations = new PresentationRegistry()`, the `presentationControlToken`, `createControlToken`, and `hasControlToken`; import the singleton instead and keep ONLY `/preview/:token/*`, `GET /api/presentations`, `DELETE /api/presentations/:id`:

```ts
import { Hono } from 'hono';
import { resolvePresentationFile } from '../presentations';
import { presentations } from '../presentationRegistry';
import { previewMime } from './previewMime';

export const presentationsRoutes = new Hono();

presentationsRoutes.get('/preview/:token/*', (c) => {
  const preview = presentations.findByToken(c.req.param('token'));
  if (!preview) return c.notFound();
  try {
    const prefix = `/preview/${preview.token}/`;
    const file = resolvePresentationFile(
      preview.root,
      decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length)),
    );
    return new Response(Bun.file(file), {
      headers: { 'Content-Type': previewMime(file), 'Cache-Control': 'no-store' },
    });
  } catch {
    return c.notFound();
  }
});

presentationsRoutes.get('/api/presentations', (c) => c.json(presentations.list()));
presentationsRoutes.delete('/api/presentations/:id', (c) =>
  c.json({ ok: presentations.close(c.req.param('id')) }),
);
```

Create `controlApp.ts` — the moved control handlers, ungated:

```ts
import { Hono } from 'hono';
import { presentations } from './presentationRegistry';
import { pairControl } from './pairControl';
import type { SignalState } from './sessionActivity';
import { signalSession } from './signalSession';

const SIGNAL_STATES: readonly SignalState[] = ['working', 'waiting', 'done'];
const isSignalState = (v: unknown): v is SignalState =>
  typeof v === 'string' && (SIGNAL_STATES as readonly string[]).includes(v);
const words = (v: unknown, limit: number): string | undefined =>
  typeof v === 'string' && v ? v.slice(0, limit) : undefined;

export const controlApp = new Hono();

controlApp.post('/control/presentations', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.entry !== 'string') return c.json({ error: 'missing entry' }, 400);
  try {
    return c.json(
      presentations.create({
        entry: body.entry,
        project: typeof body.project === 'string' ? body.project : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      }),
    );
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

controlApp.post('/control/presentations/reset', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    cleared: presentations.reset(typeof body.project === 'string' ? body.project : undefined),
  });
});

controlApp.post('/control/signal', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.sessionId !== 'string' || !body.sessionId)
    return c.json({ error: 'missing sessionId' }, 400);
  if (!isSignalState(body.state))
    return c.json({ error: `state must be one of ${SIGNAL_STATES.join(', ')}` }, 400);
  const known = signalSession(body.sessionId, body.state, {
    title: words(body.title, 100),
    body: words(body.body, 400),
  });
  if (!known) return c.json({ error: 'unknown session' }, 404);
  return c.json({ ok: true });
});

controlApp.route('/', pairControl.routes);
```

In `pairControl.ts`: ungate all four pair routes by turning the single `gated(c, then)` wrapper (`pairControl.ts:101`) into a passthrough, and remove the now-unused `hasControlToken` import and the `Context` import if it becomes unused:

```ts
// The unix socket's filesystem perms are the auth now; no header token.
function gated(_c: Context, then: () => Response | Promise<Response>): Response | Promise<Response> {
  return then();
}
```

The router is already exported as `pairControl.routes` (and `pairControlRoutes`), with full `/control/pair/*` paths, so `controlApp.route('/', pairControl.routes)` mounts them unchanged. (`pairControlRoutes` stays exported for now; Task 3 removes its mount from the network `app`.)

In `routes/signal.ts`: this router is now redundant (its handler moved into `controlApp`). Delete `routes/signal.ts` and `routes/signal.test.ts` if present, OR keep the file but have it re-export nothing mounted on the network app. Simplest: delete it and remove its import/mount from `app.ts` (done in Task 3).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/server run test controlApp`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/presentationRegistry.ts apps/server/src/server/controlApp.ts apps/server/src/server/controlApp.test.ts apps/server/src/server/routes/presentations.ts apps/server/src/server/routes/signal.ts apps/server/src/server/pairControl.ts
git commit -m "feat(server): assemble ungated controlApp; hoist presentation registry"
```

---

### Task 3: Serve controlApp over the socket; remove /control/* from the network app

**Files:**
- Modify: `serve.ts` (open the unix listener after the TCP listeners)
- Modify: `app.ts` (stop mounting `signalRoutes`; keep `presentationsRoutes` and `pairControlRoutes` OFF the network app for their `/control/*` parts — see below)
- Test: `controlServe.test.ts`

**Interfaces:**
- Consumes: `controlApp`, `CONTROL_SOCK`, `prepareControlSocket`, `hardenControlSocket`.
- Produces: `serveControl(sock?: string): { stop(closeActive?: boolean): void }` exported from `serve.ts` (or a new `controlServe.ts` if you prefer to keep `serve.ts` lean — put it in `controlServe.ts` and call it from `serve()`).

Mounting rule after this task:
- Network `app` (`app.ts`): mounts `presentationsRoutes` (now only `/preview` + `/api/presentations`), `noiseRoutes`, `configRoutes`, `filesRoutes`, `fsRoutes`, `gitRoutes`, `sessionsRoutes`. It NO LONGER mounts `signalRoutes` or any `/control/*`.
- `pairControlRoutes`: currently `app.route('/', pairControlRoutes)` (`app.ts:164`). Remove that line — pair control now lives only in `controlApp`.

- [ ] **Step 1: Write the failing test**

```ts
// controlServe.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from './app';
import { serveControl } from './controlServe';

const sock = path.join(mkdtempSync(path.join(tmpdir(), 'tether-ctl-')), 'control.sock');
const server = serveControl(sock);
afterAll(() => server.stop(true));

describe('control socket', () => {
  test('serves /control/pair/open over the unix socket', async () => {
    const res = await fetch('http://localhost/control/pair/open', {
      unix: sock,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    } as RequestInit);
    expect(res.status).toBe(200);
    await fetch('http://localhost/control/pair/close', {
      unix: sock, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    } as RequestInit);
  });

  test('the network app no longer answers /control/*', async () => {
    const res = await app.request('/control/pair/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  test('the network app still answers /api/presentations (authless call is 401, not 404)', async () => {
    const res = await app.request('/api/presentations');
    // Route exists (gated by authMiddleware) → 401. A 404 would mean we unmounted too much.
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/server run test controlServe`
Expected: FAIL — `Cannot find module './controlServe'`.

- [ ] **Step 3: Write minimal implementation**

Create `controlServe.ts`:

```ts
import { controlApp } from './controlApp';
import { hardenControlSocket, prepareControlSocket } from './controlSocket';
import { logError, logInfo } from './log';
import { CONTROL_SOCK } from './paths';

export function serveControl(sock: string = CONTROL_SOCK) {
  prepareControlSocket(sock);
  const server = Bun.serve({
    unix: sock,
    fetch: (req) => controlApp.fetch(req),
    error(err: Error) {
      logError('Control socket request error:', err);
      return new Response('Internal Server Error', { status: 500 });
    },
  });
  hardenControlSocket(sock);
  logInfo(`Control plane on unix socket ${sock}`);
  return server;
}
```

In `serve.ts`, inside `serve()` after the TCP `Bun.serve` calls, add:

```ts
import { serveControl } from './controlServe';
// ...
serveControl();
```

In `app.ts`:
- Remove `import { signalRoutes } from './routes/signal';` and its `app.route('/', signalRoutes);` line.
- Remove `import { pairControlRoutes } from ...;` and its `app.route('/', pairControlRoutes);` line (`app.ts:164`).
- Keep `app.route('/', presentationsRoutes);` (now only `/preview` + `/api/presentations`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/server run test controlServe`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/controlServe.ts apps/server/src/server/serve.ts apps/server/src/server/app.ts
git commit -m "feat(server): serve control plane on unix socket; drop /control/* from network app"
```

---

### Task 4: Migrate `present` CLI to the unix socket

**Files:**
- Modify: `presentCli.ts` (drop `tokenFile`, `baseUrl`, `port`, `tls`; add `sock`)
- Modify: `presentCli.test.ts`

**Interfaces:**
- Produces: `PresentDeps` now `{ sock: string; fetch?: (input, init?) => Promise<Response>; hasCommand?: ... }`. `runPresent` calls `fetch(\`http://localhost${endpoint}\`, { unix: deps.sock, method: 'POST', headers: {'Content-Type':'application/json'}, body })`.

- [ ] **Step 1: Update the failing test**

```ts
// presentCli.test.ts — the request assertion
test('runPresent posts the resolved entry over the unix socket, no token header', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response('{}', { status: 200 });
  };
  await runPresent(
    { kind: 'open', entry: 'card.html' },
    { sock: '/tmp/x.sock', fetch: fakeFetch },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('http://localhost/control/presentations');
  expect((calls[0].init as { unix?: string }).unix).toBe('/tmp/x.sock');
  expect((calls[0].init.headers as Record<string, string>)['X-Tether-Present-Control']).toBeUndefined();
});
```

(Keep the existing `agent-install` tests unchanged — they don't hit the socket.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/server run test presentCli`
Expected: FAIL — `sock` not on `PresentDeps` / still sends token header.

- [ ] **Step 3: Update `runPresent` + `PresentDeps`**

Replace the `PresentDeps` interface fields `port`/`baseUrl`/`tokenFile` with `sock: string`. In `runPresent`, drop the `readFileSync(deps.tokenFile)` line and the `base`/`tls` logic; build the request as:

```ts
const res = await (deps.fetch ?? fetch)(`http://localhost${endpoint}`, {
  unix: deps.sock,
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
} as RequestInit);
```

Leave `installAgentSkill`/`parsePresentArgs`/`SKILL` untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/server run test presentCli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/presentCli.ts apps/server/src/server/presentCli.test.ts
git commit -m "feat(server): present CLI talks to control socket"
```

---

### Task 5: Migrate `signal` CLI to the unix socket

**Files:**
- Modify: `signalCli.ts`
- Modify: `signalCli.test.ts`

**Interfaces:**
- Produces: `SignalDeps` now `{ sock: string; sessionId?: string; fetch?: ... }` (drop `baseUrl`, `tokenFile`). Request: `fetch(\`http://localhost/control/signal\`, { unix: deps.sock, method:'POST', headers:{'Content-Type':'application/json'}, body })`.

- [ ] **Step 1: Update the failing test**

```ts
// signalCli.test.ts
test('runSignal posts state over the unix socket without a token header', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response('{}', { status: 200 });
  };
  await runSignal(
    { kind: 'send', state: 'waiting' },
    { sock: '/tmp/x.sock', sessionId: 'sess-1', fetch: fakeFetch },
  );
  expect(calls[0].url).toBe('http://localhost/control/signal');
  expect((calls[0].init as { unix?: string }).unix).toBe('/tmp/x.sock');
  expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ sessionId: 'sess-1', state: 'waiting' });
});
```

(Keep the `hooks` test and the "no sessionId throws" test — the guard stays.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/server run test signalCli`
Expected: FAIL.

- [ ] **Step 3: Update `runSignal` + `SignalDeps`**

Drop `baseUrl`/`tokenFile` from `SignalDeps`, add `sock: string`. Remove the `readFileSync(deps.tokenFile)` and `tls` logic. Keep the `if (!deps.sessionId) throw` guard. Build the request with `{ unix: deps.sock, ... }` and no `X-Tether-Present-Control` header. `claudeHookSnippet()` unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/server run test signalCli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/signalCli.ts apps/server/src/server/signalCli.test.ts
git commit -m "feat(server): signal CLI talks to control socket"
```

---

### Task 6: Migrate `pair` CLI to the unix socket

**Files:**
- Modify: `pairCli.ts`
- Modify: `pairCli.test.ts`

**Interfaces:**
- Produces: `PairDeps` now `{ sock: string; advertiseUrl?; qr?; fetch?; log?; readLine? }` (drop `port`, `baseUrl`, `tokenFile`). `controlRequest(deps, path, init)` builds `fetch(\`http://localhost${path}\`, { ...init, unix: deps.sock, headers: {'Content-Type':'application/json', ...init.headers} })` — no token read, no `tls`.

- [ ] **Step 1: Update the failing test**

```ts
// pairCli.test.ts — adapt the existing happy-path test's deps
const base = { sock: '/tmp/x.sock', log: () => {}, readLine: async () => 'y' };
// ...the fake fetch asserts each URL is http://localhost/control/pair/* and init.unix === '/tmp/x.sock'
```

Update the existing pair flow test(s) to construct `PairDeps` with `sock` instead of `port`/`baseUrl`/`tokenFile`, and assert the fake fetch received `init.unix === '/tmp/x.sock'` and no `X-Tether-Present-Control` header on at least one call.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/server run test pairCli`
Expected: FAIL.

- [ ] **Step 3: Update `controlRequest` + `PairDeps`**

```ts
async function controlRequest(deps: PairDeps, p: string, init: RequestInit = {}): Promise<Response> {
  return (deps.fetch ?? fetch)(`http://localhost${p}`, {
    ...init,
    unix: deps.sock,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  } as RequestInit);
}
```

Remove `readFileSync`, `tokenFile`, `port`, `baseUrl`, `tls` from the file and `PairDeps`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/server run test pairCli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/pairCli.ts apps/server/src/server/pairCli.test.ts
git commit -m "feat(server): pair CLI talks to control socket"
```

---

### Task 7: Rewire `main.ts` dispatch + delete the control-token machinery

**Files:**
- Modify: `main.ts` (the `present`/`pair`/`signal` cases — pass `sock: CONTROL_SOCK`, drop `resolveListenerPlan`/`baseUrl`/`port`/`tokenFile`)
- Modify: `paths.ts` (delete `PRESENT_CONTROL_TOKEN_FILE`)
- Modify: `presentations.ts` (delete `createControlToken` if it lives there) and any remaining `PRESENT_CONTROL_TOKEN_FILE` / `createControlToken` references
- Grep-sweep: no remaining `X-Tether-Present-Control`, `hasControlToken`, `createControlToken`, `PRESENT_CONTROL_TOKEN_FILE`, `present-control-token` anywhere under `apps/server/src`.

**Interfaces:**
- Consumes: `CONTROL_SOCK` from `paths.ts`.

- [ ] **Step 1: Rewire the three dispatch cases**

Replace each of the `present`/`pair`/`signal` cases in `main.ts` (currently building `baseUrl` from `resolveListenerPlan()` and passing `tokenFile: PRESENT_CONTROL_TOKEN_FILE`). Example for `present`:

```ts
case 'present': {
  const { parsePresentArgs, runPresent } = await import('./presentCli');
  try {
    await runPresent(parsePresentArgs(process.argv.slice(3)), { sock: CONTROL_SOCK });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  break;
}
```

`pair` keeps its `advertiseUrl`/`firstNonLoopbackIPv4` logic but swaps `port`/`baseUrl`/`tokenFile` → `sock: CONTROL_SOCK`. `signal` passes `{ sock: CONTROL_SOCK, sessionId: process.env.TETHER_SESSION_ID }`. Update the `paths.ts` import line to drop `PRESENT_CONTROL_TOKEN_FILE` and add `CONTROL_SOCK`.

- [ ] **Step 2: Delete the token machinery**

Remove from `paths.ts`: `PRESENT_CONTROL_TOKEN_FILE`. Remove `createControlToken` (wherever defined — check `presentations.ts`) and the daemon-side token file write. Run the sweep:

```bash
grep -rn "X-Tether-Present-Control\|hasControlToken\|createControlToken\|PRESENT_CONTROL_TOKEN_FILE\|present-control-token" apps/server/src
```

Expected: no matches. Fix any straggler.

- [ ] **Step 3: Run the full server suite + lint**

Run:
```bash
bun --cwd apps/server run test
bun lint
```
Expected: all green. (Watch for now-dangling imports in `main.ts`, `serve.ts`, deleted `routes/signal.ts`.)

- [ ] **Step 4: Manual smoke (optional but recommended)**

```bash
bun build:server
./apps/server/dist/tether start
TETHER_SESSION_ID=smoke ./apps/server/dist/tether signal working   # expect no error / "unknown session" 404 is fine
./apps/server/dist/tether present ./some.html                       # expect "Preview opened."
./apps/server/dist/tether stop
```

Confirm `~/.tether/control.sock` exists while running and that `curl http://127.0.0.1:8085/control/pair/open -X POST` now 404s (no longer on the TCP port).

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/main.ts apps/server/src/server/paths.ts apps/server/src/server/presentations.ts
git commit -m "refactor(server): control CLIs use socket path; delete control-token machinery"
```

---

## Self-Review

**Spec coverage (§4.1):**
- Control socket at `~/.tether/control.sock`, `0700` dir + `0600` sock → Task 1.
- Daemon opens the socket alongside http/https listeners → Task 3.
- `present`/`signal`/`pair` CLIs connect to the socket → Tasks 4–6, wired in Task 7.
- Drop `X-Tether-Present-Control` + `present-control-token` → Tasks 2 (gate removal) + 7 (machinery deletion + sweep).
- Remove `/control/*` from network app → Task 3.
- Handlers unchanged (`create`/`reset`/`signalSession`/`pairControl`) → Task 2 moves them verbatim.
- Tests: socket round-trip + old TCP path 404s + sock `0600` + pair round-trip → Tasks 1, 3.

**Placeholder scan:** none — every code step has real content. The one soft spot (umask masking `mkdir` mode) is called out with a concrete fallback (explicit `chmodSync`).

**Type consistency:** `sock: string` is the single new dep field across `PresentDeps`/`SignalDeps`/`PairDeps` (Tasks 4/5/6); `serveControl(sock?)`, `prepareControlSocket(sock)`, `hardenControlSocket(sock)`, `CONTROL_SOCK` consistent across Tasks 1/3/7. `presentations` singleton name consistent across `presentationRegistry.ts`, `controlApp.ts`, `routes/presentations.ts`.

**pairControl shape — verified:** `pairControl.routes` (exported also as `pairControlRoutes`) is a Hono router built by `createPairRoutes` with full `/control/pair/*` paths; all four routes go through one `gated(c, then)` wrapper (`pairControl.ts:101`) that calls `hasControlToken`. Ungating is the single passthrough edit in Task 2. `app.ts:164` mounts `pairControlRoutes` on the network app — removed in Task 3.
