# iOS Agent Chat — P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working native iOS chat that drives a server-side Claude Code agent over the Noise channel — send a prompt in a chosen workspace folder, see streamed replies + tool cards. Tools auto-approve in P1 (on-phone approval is P3).

**Architecture:** New `agent` session kind with its own server registry, separate from the PTY holder model. A thin `AgentDriver` interface wraps the Claude Agent SDK so the runner/registry/protocol are testable against a fake; one adapter task binds the real SDK. New sealed `agent.*` Noise frames, hand-maintained in TS + Swift. iOS renders a SwiftUI chat surface (bubbles, streamed deltas, hand-rolled markdown/code, tool cards) and a folder picker reusing the workspace tree.

**Tech Stack:** Bun 1.4 + Hono + bun:sqlite (server), Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Swift/SwiftUI + XCTest (iOS), Noise sealed channel.

**Spec:** `docs/superpowers/specs/2026-09-07-ios-agent-chat-design.md`

## Global Constraints

- Runtime floor **Bun ≥ 1.3.14** (dev/CI on 1.4.x). PTY unaffected here, but keep the floor.
- Server auth: agent traffic rides the authenticated Noise channel only; NO new unauthenticated route. The POC `/preview/:token/chat` and `presentChat.ts` are removed in this plan (Task 12).
- Subscription auth: the daemon spawns the Agent SDK with `ANTHROPIC_API_KEY` unset — never inject an API key.
- Tests colocated (`foo.ts` + `foo.test.ts`); run server tests with `bun --cwd apps/server run test` (NOT bare `bun test`); never pin `TETHER_DB_PATH`.
- `bun:sqlite` uses `$name` params. Schema changes APPEND a new entry to the `migrations` array in `db.ts` — never edit an applied migration.
- Formatting: Biome, 2-space, single quotes, semicolons, trailing commas, width 100; run `bun format` before each commit. Comments minimal (only non-obvious "why").
- Swift tests follow existing `clients/apple/TetherKit/Tests/TetherKitTests/` patterns (e.g. `NoiseAuthTokenTests`).
- P1 tool policy: `canUseTool` always allows (no approval UI). No persistence/replay (that is P2) — a reconnect in P1 starts a fresh transcript view; the server session keeps running.

---

## File Structure

**Server (create):**
- `apps/server/src/server/agentDriver.ts` — `AgentDriver` interface + `AgentEvent` union (the SDK seam) + a `FakeAgentDriver` for tests.
- `apps/server/src/server/agentEventMap.ts` — pure map `AgentEvent → AgentFrame`.
- `apps/server/src/server/agentRegistry.ts` — `Map<sessionId, AgentSession>`; start/prompt/interrupt/kill.
- `apps/server/src/server/agentSdkDriver.ts` — real `AgentDriver` over `@anthropic-ai/claude-agent-sdk` (the one guessing-forbidden task).

**Server (modify):**
- `apps/server/src/server/db.ts` — migration: `kind` column on `sessions`; `createAgentSession` helper.
- `apps/server/src/server/noiseSessionProtocol.ts` — decode `agent.*` client messages, emit `agent.*` server frames.
- `apps/server/src/server/routes/sessions.ts` — `GET /api/sessions` returns `kind`.

**Swift (create):**
- `clients/apple/TetherKit/Sources/TetherKit/Agent/AgentMessage.swift` — view models.
- `.../Agent/MarkdownBlocks.swift` — prose/code block splitter.
- `.../Agent/AgentChatStore.swift` — `@Observable` per-session store + reducer.
- `.../Views/AgentChatView.swift` — the chat surface.
- `.../Views/AgentToolCard.swift` — collapsible tool card.

**Swift (modify):**
- `.../Noise/NoiseSessionClient.swift` — `agent.*` decode cases.
- `.../Views/SessionDrawerView.swift` — branch on `kind`; "New agent chat" entry + folder picker.

**Remove (Task 12):** `apps/server/src/server/presentChat.ts`, the `POST /preview/:token/chat` route in `routes/presentations.ts`, and `scratchpad/agentchat-poc/` usage.

---

## Task 1: Agent frame types + driver seam

**Files:**
- Create: `apps/server/src/server/agentDriver.ts`
- Test: `apps/server/src/server/agentDriver.test.ts`

**Interfaces:**
- Produces:
  - `type AgentEvent = {t:'delta';text:string} | {t:'tool';name:string;input:unknown} | {t:'tool_result';text:string;isError:boolean} | {t:'permission_req';reqId:string;name:string;input:unknown} | {t:'done';cost:number;usage:unknown} | {t:'error';message:string}`
  - `type AgentFrame` — the sealed server→client shape: same variants with a `seq:number` added on `delta|tool|tool_result|done`, `reqId` on `permission_req`.
  - `interface AgentDriver { start(cwd:string): Promise<void>; prompt(text:string): AsyncIterable<AgentEvent>; interrupt(): void; close(): void }`
  - `class FakeAgentDriver implements AgentDriver` — scriptable: constructor takes `AgentEvent[][]` (one array per prompt call) and yields them.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { FakeAgentDriver } from './agentDriver';

test('FakeAgentDriver yields the scripted events for a prompt', async () => {
  const driver = new FakeAgentDriver([
    [{ t: 'delta', text: 'Hi' }, { t: 'done', cost: 0.01, usage: {} }],
  ]);
  await driver.start('/tmp');
  const seen: string[] = [];
  for await (const ev of driver.prompt('hello')) seen.push(ev.t);
  expect(seen).toEqual(['delta', 'done']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/server run test agentDriver`
Expected: FAIL — cannot find `FakeAgentDriver`.

- [ ] **Step 3: Implement the types + fake**

```ts
export type AgentEvent =
  | { t: 'delta'; text: string }
  | { t: 'tool'; name: string; input: unknown }
  | { t: 'tool_result'; text: string; isError: boolean }
  | { t: 'permission_req'; reqId: string; name: string; input: unknown }
  | { t: 'done'; cost: number; usage: unknown }
  | { t: 'error'; message: string };

export type AgentFrame =
  | { t: 'agent.delta'; seq: number; text: string }
  | { t: 'agent.tool'; seq: number; name: string; input: unknown }
  | { t: 'agent.tool_result'; seq: number; text: string; isError: boolean }
  | { t: 'agent.permission_req'; reqId: string; name: string; input: unknown }
  | { t: 'agent.done'; seq: number; cost: number; usage: unknown }
  | { t: 'agent.error'; message: string };

export interface AgentDriver {
  start(cwd: string): Promise<void>;
  prompt(text: string): AsyncIterable<AgentEvent>;
  interrupt(): void;
  close(): void;
}

export class FakeAgentDriver implements AgentDriver {
  private call = 0;
  constructor(private readonly scripts: AgentEvent[][]) {}
  async start(_cwd: string): Promise<void> {}
  async *prompt(_text: string): AsyncIterable<AgentEvent> {
    const script = this.scripts[this.call++] ?? [];
    for (const ev of script) yield ev;
  }
  interrupt(): void {}
  close(): void {}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/server run test agentDriver`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/agentDriver.ts apps/server/src/server/agentDriver.test.ts
git commit -m "feat(server): agent driver seam + fake"
```

---

## Task 2: Pure event→frame mapper (seq assignment)

**Files:**
- Create: `apps/server/src/server/agentEventMap.ts`
- Test: `apps/server/src/server/agentEventMap.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `AgentFrame` (Task 1).
- Produces: `class FrameSeq { next(): number }` and `function toFrame(ev: AgentEvent, seq: FrameSeq): AgentFrame` — assigns a monotonic `seq` to `delta|tool|tool_result|done`; passes `error`/`permission_req` through with no `seq`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { FrameSeq, toFrame } from './agentEventMap';

test('assigns increasing seq to delta and done, none to error', () => {
  const seq = new FrameSeq();
  const a = toFrame({ t: 'delta', text: 'x' }, seq);
  const b = toFrame({ t: 'done', cost: 0, usage: {} }, seq);
  const e = toFrame({ t: 'error', message: 'boom' }, seq);
  expect(a).toEqual({ t: 'agent.delta', seq: 1, text: 'x' });
  expect(b).toEqual({ t: 'agent.done', seq: 2, cost: 0, usage: {} });
  expect(e).toEqual({ t: 'agent.error', message: 'boom' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/server run test agentEventMap`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { AgentEvent, AgentFrame } from './agentDriver';

export class FrameSeq {
  private n = 0;
  next(): number {
    return ++this.n;
  }
}

export function toFrame(ev: AgentEvent, seq: FrameSeq): AgentFrame {
  switch (ev.t) {
    case 'delta':
      return { t: 'agent.delta', seq: seq.next(), text: ev.text };
    case 'tool':
      return { t: 'agent.tool', seq: seq.next(), name: ev.name, input: ev.input };
    case 'tool_result':
      return { t: 'agent.tool_result', seq: seq.next(), text: ev.text, isError: ev.isError };
    case 'done':
      return { t: 'agent.done', seq: seq.next(), cost: ev.cost, usage: ev.usage };
    case 'permission_req':
      return { t: 'agent.permission_req', reqId: ev.reqId, name: ev.name, input: ev.input };
    case 'error':
      return { t: 'agent.error', message: ev.message };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/server run test agentEventMap`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/agentEventMap.ts apps/server/src/server/agentEventMap.test.ts
git commit -m "feat(server): pure agent event→frame mapper"
```

---

## Task 3: `kind` column migration + agent session row

**Files:**
- Modify: `apps/server/src/server/db.ts` (append migration; add `createAgentSession`)
- Test: `apps/server/src/server/db.test.ts` (add cases; create if absent following existing db test patterns)

**Interfaces:**
- Consumes: existing `sessions` schema, `migrations` array, `Session`/`SessionRow` types.
- Produces: `createAgentSession(db, {id, workspaceRoot}): void` inserting a row with `kind='agent'`, `command='<agent>'`, `status='running'`; existing session reads expose `kind`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { openDb, createAgentSession, getSession } from './db';

test('agent session row carries kind=agent and workspace_root', () => {
  const db = openDb(':memory:');
  createAgentSession(db, { id: 'a1', workspaceRoot: '/home/u/sites/tether' });
  const row = getSession(db, 'a1');
  expect(row?.kind).toBe('agent');
  expect(row?.workspace_root).toBe('/home/u/sites/tether');
});
```

(Use the DB open/access helpers already exported by `db.ts`; match their exact names — read the file first.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/server run test db`
Expected: FAIL — `kind` undefined / `createAgentSession` missing.

- [ ] **Step 3: Implement**

Append a new migration entry (do not edit existing ones):

```ts
// in the migrations array, as the next entry
{
  version: /* next integer */ 0,
  up: (db) => {
    db.run("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'pty'");
  },
},
```

Add the helper (place near other session writers; adapt to the file's existing `db.query(...).run({ $name })` idiom):

```ts
export function createAgentSession(db: Database, args: { id: string; workspaceRoot: string }): void {
  db.query(
    `INSERT INTO sessions (id, command, status, kind, workspace_root, created_at)
     VALUES ($id, '<agent>', 'running', 'agent', $root, unixepoch())`,
  ).run({ $id: args.id, $root: args.workspaceRoot });
}
```

Extend `SessionRow`/`Session` types with `kind: 'pty' | 'agent'`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/server run test db`
Expected: PASS. Then full suite: `bun --cwd apps/server run test` — no regressions.

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/db.ts apps/server/src/server/db.test.ts
git commit -m "feat(server): sessions.kind column + createAgentSession"
```

---

## Task 4: Agent registry (start / prompt-stream / interrupt / kill)

**Files:**
- Create: `apps/server/src/server/agentRegistry.ts`
- Test: `apps/server/src/server/agentRegistry.test.ts`

**Interfaces:**
- Consumes: `AgentDriver`, `AgentEvent`, `AgentFrame` (Task 1); `FrameSeq`, `toFrame` (Task 2).
- Produces:
  - `type FrameSink = (f: AgentFrame) => void`
  - `class AgentRegistry` constructed with a `driverFactory: () => AgentDriver`.
  - `start(id, cwd): Promise<void>`
  - `attach(id, sink): () => void` — subscribe a client; returns unsubscribe.
  - `prompt(id, text): Promise<void>` — pulls the driver's event stream, maps via `toFrame`, fans out to sinks.
  - `interrupt(id): void`, `kill(id): void`, `has(id): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { AgentRegistry } from './agentRegistry';
import { FakeAgentDriver } from './agentDriver';
import type { AgentFrame } from './agentDriver';

test('prompt fans mapped frames with monotonic seq to attached sink', async () => {
  const reg = new AgentRegistry(
    () => new FakeAgentDriver([[{ t: 'delta', text: 'Hi' }, { t: 'done', cost: 0, usage: {} }]]),
  );
  await reg.start('a1', '/tmp');
  const got: AgentFrame[] = [];
  reg.attach('a1', (f) => got.push(f));
  await reg.prompt('a1', 'hello');
  expect(got.map((f) => f.t)).toEqual(['agent.delta', 'agent.done']);
  expect((got[0] as any).seq).toBe(1);
  expect((got[1] as any).seq).toBe(2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/server run test agentRegistry`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { AgentDriver, AgentFrame } from './agentDriver';
import { FrameSeq, toFrame } from './agentEventMap';

export type FrameSink = (f: AgentFrame) => void;

interface Entry {
  driver: AgentDriver;
  seq: FrameSeq;
  sinks: Set<FrameSink>;
}

export class AgentRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly driverFactory: () => AgentDriver) {}

  async start(id: string, cwd: string): Promise<void> {
    if (this.entries.has(id)) return;
    const driver = this.driverFactory();
    await driver.start(cwd);
    this.entries.set(id, { driver, seq: new FrameSeq(), sinks: new Set() });
  }

  attach(id: string, sink: FrameSink): () => void {
    const e = this.entries.get(id);
    if (!e) throw new Error(`no agent session ${id}`);
    e.sinks.add(sink);
    return () => e.sinks.delete(sink);
  }

  async prompt(id: string, text: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`no agent session ${id}`);
    for await (const ev of e.driver.prompt(text)) {
      const frame = toFrame(ev, e.seq);
      for (const sink of e.sinks) sink(frame);
    }
  }

  interrupt(id: string): void {
    this.entries.get(id)?.driver.interrupt();
  }

  kill(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.driver.close();
    this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/server run test agentRegistry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/agentRegistry.ts apps/server/src/server/agentRegistry.test.ts
git commit -m "feat(server): agent session registry"
```

---

## Task 5: Wire `agent.*` into the Noise protocol

**Files:**
- Modify: `apps/server/src/server/noiseSessionProtocol.ts`
- Test: `apps/server/src/server/noiseSessionProtocol.test.ts` (add cases; match existing test harness in this file's sibling test)

**Interfaces:**
- Consumes: `AgentRegistry` (Task 4), `createAgentSession` (Task 3).
- Produces: the Noise session loop handles client messages `agent.start {id,cwd}`, `agent.prompt {text}`, `agent.interrupt`; forwards registry frames to the sealed sender. A single `AgentRegistry` instance is created where the PTY registry is wired (module scope in `noiseSessionProtocol.ts` or its caller — follow the existing PTY wiring site).

- [ ] **Step 1: Write the failing test**

Read the existing `noiseSessionProtocol.test.ts` to reuse its fake sealed-channel harness. Then add:

```ts
test('agent.start then agent.prompt emits agent.delta/agent.done over the sealed channel', async () => {
  // Arrange: build the session loop with a registry whose driverFactory is a FakeAgentDriver
  // scripting [delta 'Hi', done]. Use the file's existing harness to capture sealed sends.
  // Act: feed {t:'agent.start', id:'a1', cwd:'/tmp'} then {t:'agent.prompt', text:'hello'}.
  // Assert: captured sealed messages include {t:'agent.delta', text:'Hi'} then {t:'agent.done'}.
});
```

Fill the body against the actual harness API in that test file (the design mirrors how the PTY `start`/`output` path is tested there).

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/server run test noiseSessionProtocol`
Expected: FAIL — `agent.*` unhandled.

- [ ] **Step 3: Implement**

Add to the client-message union/decode and the dispatch switch (mirror the PTY `start`/`input` handlers):

```ts
// in applyMessage / the message switch:
case 'agent.start': {
  createAgentSession(db, { id: msg.id, workspaceRoot: msg.cwd });
  await agents.start(msg.id, msg.cwd);
  const detach = agents.attach(msg.id, (frame) => sendSealed(frame));
  onClose(detach); // unsubscribe when this Noise socket closes (use the loop's existing teardown hook)
  break;
}
case 'agent.prompt':
  void agents.prompt(currentAgentId, msg.text);
  break;
case 'agent.interrupt':
  agents.interrupt(currentAgentId);
  break;
```

Track `currentAgentId` from the last `agent.start` on this socket (same pattern as the current session id tracking). Instantiate `const agents = new AgentRegistry(() => makeAgentDriver())` at the wiring site; `makeAgentDriver` comes from Task 11 (until then, a `FakeAgentDriver` factory guarded behind a TODO-free injected default is acceptable — inject the factory so tests pass a fake and production passes the real one).

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/server run test noiseSessionProtocol`
Expected: PASS. Full suite green.

- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/noiseSessionProtocol.ts apps/server/src/server/noiseSessionProtocol.test.ts
git commit -m "feat(server): agent.* messages over Noise"
```

---

## Task 6: `GET /api/sessions` returns `kind`

**Files:**
- Modify: `apps/server/src/server/routes/sessions.ts`
- Test: `apps/server/src/server/routes/sessions.test.ts` (add a case; if the list mapping is a pure helper, test that helper directly)

**Interfaces:**
- Consumes: `SessionRow.kind` (Task 3).
- Produces: each `/api/sessions` entry includes `kind: 'pty' | 'agent'`.

- [ ] **Step 1: Write the failing test**

```ts
test('session list includes kind', () => {
  // Given a SessionRow with kind='agent', the list mapper output has kind:'agent'.
  // Call the same row→dto mapper the route uses (extract it if inline).
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `bun --cwd apps/server run test sessions` → FAIL.
- [ ] **Step 3: Implement** — add `kind: row.kind` to the row→dto mapping.
- [ ] **Step 4: Run to verify it passes** — Run: `bun --cwd apps/server run test sessions` → PASS.
- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/routes/sessions.ts apps/server/src/server/routes/sessions.test.ts
git commit -m "feat(server): expose session kind in list API"
```

---

## Task 7: Swift — decode `agent.*` server frames

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Noise/NoiseSessionClient.swift`
- Test: `clients/apple/TetherKit/Tests/TetherKitTests/AgentFrameDecodeTests.swift` (create)

**Interfaces:**
- Produces: `NoiseServerMessage` gains cases `.agentDelta(seq:Int,text:String)`, `.agentTool(seq:Int,name:String,input:JSONValue)`, `.agentToolResult(seq:Int,text:String,isError:Bool)`, `.agentDone(seq:Int,cost:Double)`, `.agentError(message:String)`. (Use the codebase's existing JSON value type for `input`; if none, decode `input` as raw `Data`/String.)

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import TetherKit

final class AgentFrameDecodeTests: XCTestCase {
  func testDecodesAgentDelta() throws {
    let json = #"{"t":"agent.delta","seq":3,"text":"Hi"}"#.data(using: .utf8)!
    let msg = try NoiseServerMessage.decode(from: json)  // match the file's actual decode entry point
    guard case let .agentDelta(seq, text) = msg else { return XCTFail("wrong case") }
    XCTAssertEqual(seq, 3)
    XCTAssertEqual(text, "Hi")
  }
}
```

(Read `NoiseSessionClient.swift` first to use the real decode entry point / initializer used by existing cases.)

- [ ] **Step 2: Run to verify it fails**

Run: `xcodebuild test -project clients/apple/Tether.xcodeproj -scheme TetherIOS -only-testing:TetherKitTests/AgentFrameDecodeTests` (see `clients/apple/README.md` for the exact sim destination flags)
Expected: FAIL — cases missing.

- [ ] **Step 3: Implement** — add the enum cases and their branches in the custom `Decodable` `switch` on `t`, mirroring the existing `"output"`/`"exit"` cases.

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Noise/NoiseSessionClient.swift clients/apple/TetherKit/Tests/TetherKitTests/AgentFrameDecodeTests.swift
git commit -m "feat(ios): decode agent.* noise frames"
```

---

## Task 8: Swift — markdown block splitter

**Files:**
- Create: `clients/apple/TetherKit/Sources/TetherKit/Agent/MarkdownBlocks.swift`
- Test: `clients/apple/TetherKit/Tests/TetherKitTests/MarkdownBlocksTests.swift`

**Interfaces:**
- Produces: `enum MarkdownBlock { case prose(String); case code(language: String?, body: String) }` and `func splitMarkdownBlocks(_ text: String) -> [MarkdownBlock]` — splits on fenced ```` ```lang ```` … ```` ``` ```` regions; everything else is prose.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import TetherKit

final class MarkdownBlocksTests: XCTestCase {
  func testSplitsFencedCodeFromProse() {
    let input = "Here:\n```swift\nlet x = 1\n```\nDone."
    let blocks = splitMarkdownBlocks(input)
    XCTAssertEqual(blocks.count, 3)
    guard case let .prose(p0) = blocks[0], case let .code(lang, body) = blocks[1],
          case let .prose(p2) = blocks[2] else { return XCTFail() }
    XCTAssertTrue(p0.contains("Here:"))
    XCTAssertEqual(lang, "swift")
    XCTAssertEqual(body, "let x = 1")
    XCTAssertTrue(p2.contains("Done."))
  }

  func testPlainTextIsOneProseBlock() {
    XCTAssertEqual(splitMarkdownBlocks("just text").count, 1)
  }
}
```

- [ ] **Step 2: Run to verify it fails** — run the test target → FAIL.
- [ ] **Step 3: Implement** the fence scanner (line-based: toggle on a line starting with ```` ``` ````; capture the language after the opening fence; accumulate body lines until the closing fence). Trim a single trailing newline from prose/code bodies.
- [ ] **Step 4: Run to verify it passes** → PASS (both cases).
- [ ] **Step 5: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Agent/MarkdownBlocks.swift clients/apple/TetherKit/Tests/TetherKitTests/MarkdownBlocksTests.swift
git commit -m "feat(ios): markdown prose/code block splitter"
```

---

## Task 9: Swift — AgentChatStore reducer

**Files:**
- Create: `clients/apple/TetherKit/Sources/TetherKit/Agent/AgentMessage.swift`, `.../Agent/AgentChatStore.swift`
- Test: `clients/apple/TetherKit/Tests/TetherKitTests/AgentChatStoreTests.swift`

**Interfaces:**
- Consumes: the `NoiseServerMessage` agent cases (Task 7).
- Produces:
  - `struct AgentMessage: Identifiable { let id; var role: Role; var text: String; var tools: [AgentToolCall] }` (`Role = .user | .assistant`).
  - `struct AgentToolCall: Identifiable { let id; let name: String; let input: String; var result: String?; var isError: Bool }`
  - `@Observable final class AgentChatStore` with `messages: [AgentMessage]`, `turnState`, and `func apply(_ msg: NoiseServerMessage)` reducing: `.agentDelta` appends to the last assistant message (creating one if the last is a user message), `.agentTool` appends a tool call, `.agentToolResult` fills the matching call's result, `.agentDone` sets `.idle`. Plus `func sendPrompt(_ text: String)` which appends a user message and asks the client to send `agent.prompt`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import TetherKit

@MainActor
final class AgentChatStoreTests: XCTestCase {
  func testDeltasCoalesceIntoOneAssistantBubble() {
    let store = AgentChatStore(sessionId: "a1", send: { _ in })
    store.appendUser("hello")
    store.apply(.agentDelta(seq: 1, text: "Hel"))
    store.apply(.agentDelta(seq: 2, text: "lo"))
    store.apply(.agentDone(seq: 3, cost: 0))
    XCTAssertEqual(store.messages.count, 2)               // user + one assistant
    XCTAssertEqual(store.messages.last?.text, "Hello")
  }
}
```

- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement** the models + store reducer (main-actor `@Observable`). `send` is the injected closure that serializes an `agent.prompt`.
- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Agent/AgentMessage.swift clients/apple/TetherKit/Sources/TetherKit/Agent/AgentChatStore.swift clients/apple/TetherKit/Tests/TetherKitTests/AgentChatStoreTests.swift
git commit -m "feat(ios): agent chat store + reducer"
```

---

## Task 10: Swift — chat view, tool card, drawer entry + folder picker

**Files:**
- Create: `.../Views/AgentChatView.swift`, `.../Views/AgentToolCard.swift`
- Modify: `.../Views/SessionDrawerView.swift`
- Test: (UI wiring — covered by the store tests above + manual device pass; no new unit test required unless a pure helper is extracted.)

**Interfaces:**
- Consumes: `AgentChatStore` (Task 9), `splitMarkdownBlocks` (Task 8), `HighlightedCodeText` (existing).

- [ ] **Step 1: Build `AgentToolCard`** — a `DisclosureGroup` showing `name` + summary; body renders `input` (monospace). Result (when present) shown under it; red tint on `isError`.
- [ ] **Step 2: Build `AgentChatView`** — `ScrollViewReader { ScrollView { LazyVStack { ForEach(store.messages) { bubble } } } }`. Bubble renders each `MarkdownBlock`: `.prose` → `Text(try? AttributedString(markdown:)) ?? Text(raw)`; `.code` → `HighlightedCodeText`. Assistant tool calls render `AgentToolCard`. Composer `TextField` + Send calls `store.sendPrompt`. Auto-scroll: `.onChange(of: store.messages.last?.text)` and `.onChange(of: store.messages.count)` → `withAnimation { proxy.scrollTo(bottomID, anchor: .bottom) }` (never inline in the same state update).
- [ ] **Step 3: Drawer** — in `SessionDrawerView`, branch rows on `session.kind`: agent → chat glyph, tapping opens `AgentChatView`. Add a "New agent chat" affordance that presents the existing workspace file-tree/dir browser; on folder pick, generate a session id and send `agent.start {id, cwd}` then open the chat.
- [ ] **Step 4: Build** the app for the sim: `xcodebuild -project clients/apple/Tether.xcodeproj -scheme TetherIOS build` (per `clients/apple/README.md`). Expected: compiles.
- [ ] **Step 5: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Views/AgentChatView.swift clients/apple/TetherKit/Sources/TetherKit/Views/AgentToolCard.swift clients/apple/TetherKit/Sources/TetherKit/Views/SessionDrawerView.swift
git commit -m "feat(ios): agent chat view + drawer entry + folder picker"
```

---

## Task 11: Real Agent SDK driver

**Files:**
- Create: `apps/server/src/server/agentSdkDriver.ts`
- Modify: the wiring site from Task 5 to use `makeAgentDriver = () => new AgentSdkDriver()` in production.
- Test: none (integration boundary; exercised by the smoke test in Task 13). Keep ALL logic thin — parsing/mapping already lives in tested modules.

**⚠ Guessing forbidden.** Read the Claude Agent SDK docs (`code.claude.com/docs/en/agent-sdk`) for the exact `query()` options, streaming-input shape, event types, and interrupt/abort API BEFORE writing. Do not infer names from the Anthropic API SDK.

**Interfaces:**
- Produces: `class AgentSdkDriver implements AgentDriver` (Task 1). `start(cwd)` opens a streaming `query` session pinned to `cwd`; `prompt(text)` pushes a user turn and yields translated `AgentEvent`s (assistant text delta → `{t:'delta'}`, tool use → `{t:'tool'}`, tool result → `{t:'tool_result'}`, result → `{t:'done'}`, error → `{t:'error'}`); `interrupt()`/`close()` map to the SDK's abort/close. Spawn with `ANTHROPIC_API_KEY` stripped from the child env. P1: permission callback (if the SDK requires one) returns allow for every tool.

- [ ] **Step 1:** Read the Agent SDK docs; note the exact `query` signature, the message/event enum, the permission hook name, and the interrupt API in a comment block at the top of the file.
- [ ] **Step 2:** Implement `AgentSdkDriver` against those real APIs, translating SDK events to `AgentEvent`. Keep the translation a small pure function you can later lift into a `.test.ts` if the shape stabilizes.
- [ ] **Step 3:** Wire `makeAgentDriver` to it in production; keep the injected-fake path for tests.
- [ ] **Step 4:** Typecheck: `bun lint`. Expected: clean.
- [ ] **Step 5: Commit**

```bash
bun format
git add apps/server/src/server/agentSdkDriver.ts apps/server/src/server/noiseSessionProtocol.ts
git commit -m "feat(server): real Claude Agent SDK driver"
```

---

## Task 12: Remove the POC bridge

**Files:**
- Delete: `apps/server/src/server/presentChat.ts`
- Modify: `apps/server/src/server/routes/presentations.ts` (remove the `POST /preview/:token/chat` route + the `runClaudeChat` import)

- [ ] **Step 1:** Delete `presentChat.ts` and the route + import.
- [ ] **Step 2:** Run `bun --cwd apps/server run test` — full suite green (no test depended on the POC route).
- [ ] **Step 3:** `bun lint` — clean (no dangling import).
- [ ] **Step 4: Commit**

```bash
bun format
git add -A apps/server/src/server/routes/presentations.ts
git rm apps/server/src/server/presentChat.ts
git commit -m "chore(server): remove agent-chat POC bridge"
```

---

## Task 13: End-to-end smoke on the simulator

**Files:** none (verification task).

- [ ] **Step 1:** Build + install the app on the sim and run the daemon from the fresh build (`clients/apple/README.md` for build/run; `bun build:server && ./apps/server/dist/tether restart` for the daemon).
- [ ] **Step 2:** In the app: open the drawer → New agent chat → pick a repo folder → send "list the files here with ls and summarize". Expect: streamed assistant text, a Bash tool card with its result, `agent.done`.
- [ ] **Step 3:** Send a follow-up ("what did I just ask?") — expect context retained (same driver session).
- [ ] **Step 4:** Confirm a second concurrent agent chat in a different folder runs independently (separate registry entries).
- [ ] **Step 5:** No commit; record results in the board task.

---

## Self-Review

**Spec coverage (P1 rows of §6):** session `kind` + registry → Tasks 3,4; `agent.*` protocol → Tasks 1,5,7; runner (auto-approve) → Tasks 4,11; bubbles/deltas/markdown/code → Tasks 8,9,10; folder picker → Task 10; drawer branch → Tasks 6,10; POC removal → Task 12. Persistence/replay (P2), approval (P3), diffs/interrupt (P4) intentionally deferred.

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". The one read-the-docs task (11) is a real integration boundary with a defined target interface (`AgentDriver`), not a placeholder — its neighbors are fully specified and tested against `FakeAgentDriver`.

**Type consistency:** `AgentEvent`/`AgentFrame` (Task 1) consumed unchanged in Tasks 2,4,11; `toFrame`/`FrameSeq` names match across 2 and 4; `createAgentSession` signature matches between Task 3 and its use in Task 5; Swift `NoiseServerMessage` agent cases match between Task 7 and the reducer in Task 9; `splitMarkdownBlocks`/`MarkdownBlock` match between Task 8 and the view in Task 10.
