# Desktop Agent-Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the agent-chat feature to `apps/desktop` at full parity with the shipped iOS client, chats syncing across devices via the server.

**Architecture:** Chat is a session with `kind='agent'` whose `agent.*` JSON frames ride the existing per-host Noise session socket. Desktop Rust gains a thin *passthrough* (forward raw agent JSON, never parse it); a TS reducer (`AgentChatModel`, ported from Swift) + React panes own all agent semantics. Sync is inherent — the server stores the transcript and fans live frames to every attached device; desktop only consumes `session.kind` and attaches-with-replay.

**Tech Stack:** Rust (Tauri commands, `serde_json`), TypeScript/React, `@tauri-apps/api`, `react-markdown` + `remark-gfm`, `bun:test` / `vitest` (desktop test runner), `cargo test`.

**Spec:** `docs/superpowers/specs/2026-09-08-desktop-agent-chat-design.md`

## Global Constraints

- Bun ≥ 1.3.14 floor; dev/CI on Bun 1.4.x. Run desktop TS tests with `bun --cwd apps/desktop run test` (not bare `bun test`).
- Biome formatting: 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before each commit.
- Rust: `cd apps/desktop/src-tauri && cargo test`; format `cargo fmt`.
- No server or `tether-core` changes. Rust stays a pipe — it must never parse agent frame fields.
- Comments minimal: only a non-obvious "why", never restate the code.
- `git` in this worktree: invoke as `/usr/bin/git -C <worktree> …` (the rtk shell hook otherwise blocks worktree-isolated git).
- Swift originals are the source of truth for every port; exact anchors given per task under `clients/apple/TetherKit/Sources/TetherKit/`.

---

### Task 1: Rust inbound passthrough — surface `agent.*` frames

**Files:**
- Modify: `apps/desktop/src-tauri/src/noise_session.rs` (enum `ServerMsg` :39, `decode_server` :201)
- Modify: `apps/desktop/src-tauri/src/commands/noise.rs` (pump match :641-661)
- Test: `apps/desktop/src-tauri/src/noise_session.rs` (`#[cfg(test)]` block, alongside `decode_server_*` tests)

**Interfaces:**
- Consumes: existing `ServerMsg`, `decode_server(plaintext: &[u8]) -> Result<ServerMsg, serde_json::Error>`.
- Produces: `ServerMsg::Agent(String)` — the raw JSON line for any frame whose `t` starts with `agent.`. Pump emits it verbatim on `core-message-{conn_id}` (the existing `msg_evt`), so the frontend receives agent frames on the same event stream as terminal output and branches on the `t` field.

- [ ] **Step 1: Write the failing test**

In the `#[cfg(test)]` module of `noise_session.rs`:

```rust
#[test]
fn decode_server_agent_frame_is_passthrough() {
    let line = br#"{"t":"agent.delta","seq":3,"text":"hi"}"#;
    match decode_server(line).unwrap() {
        ServerMsg::Agent(raw) => {
            assert!(raw.contains("\"agent.delta\""));
            assert!(raw.contains("\"seq\":3"));
        }
        other => panic!("expected Agent passthrough, got {other:?}"),
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test decode_server_agent_frame_is_passthrough`
Expected: FAIL — no `ServerMsg::Agent` variant.

- [ ] **Step 3: Add the variant and decode arm**

In `enum ServerMsg` (`:39`) add:

```rust
    /// Any `agent.*` frame, carried as its raw JSON line. The Tauri layer is a
    /// pipe here — agent semantics live in the TS reducer, not in Rust.
    Agent(String),
```

In `decode_server` (`:201`), after reading the `t` field and before the final `Other` fallthrough, branch on the prefix. `decode_server` already parses the plaintext into a `serde_json::Value` to read `t`; reuse it:

```rust
    if t.starts_with("agent.") {
        // Re-serialize the parsed value so we hand the frontend a clean line.
        return Ok(ServerMsg::Agent(String::from_utf8_lossy(plaintext).into_owned()));
    }
```

(If `decode_server` does not currently keep the raw bytes in scope at that point, use `String::from_utf8_lossy(plaintext).into_owned()` — the plaintext slice is the argument and is in scope for the whole function.)

- [ ] **Step 4: Emit it from the pump**

In `commands/noise.rs`, the inbound `match decode_server(&plain)` (`:640`). Add an arm before `ServerMsg::Other`:

```rust
                            Ok(ServerMsg::Agent(raw)) => {
                                let _ = app.emit(&msg_evt, raw);
                            }
```

- [ ] **Step 5: Run tests**

Run: `cd apps/desktop/src-tauri && cargo test decode_server_agent`
Expected: PASS. Also run `cargo test` to confirm the new arm didn't break the exhaustive matches (the `Other` and devices arms still compile).

- [ ] **Step 6: Commit**

```bash
/usr/bin/git -C <worktree> add apps/desktop/src-tauri/src/noise_session.rs apps/desktop/src-tauri/src/commands/noise.rs
/usr/bin/git -C <worktree> commit -m "feat(desktop): pass agent.* frames through the noise pump"
```

---

### Task 2: Rust outbound passthrough — send `agent.*` frames

**Files:**
- Modify: `apps/desktop/src-tauri/src/noise_session.rs` (`translate_frontend` :175)
- Test: same file's `#[cfg(test)]` block

**Interfaces:**
- Consumes: `translate_frontend(session_id: &str, ws_json: &str) -> Option<Vec<u8>>`.
- Produces: for a frontend line whose `t` is `agent.start` / `agent.prompt` / `agent.interrupt` / `agent.permission`, returns the JSON bytes to seal unchanged (the server's `noiseSessionProtocol` consumes exactly this shape). The frontend is responsible for including the correct fields.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn translate_frontend_passes_agent_prompt_through() {
    let line = r#"{"t":"agent.prompt","text":"build it"}"#;
    let out = translate_frontend("s1", line).expect("agent.prompt should translate");
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["t"], "agent.prompt");
    assert_eq!(v["text"], "build it");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test translate_frontend_passes_agent_prompt_through`
Expected: FAIL — `translate_frontend` returns `None` for unknown `t`.

- [ ] **Step 3: Add the passthrough arm**

In `translate_frontend` (`:175`), after parsing `value` and reading `t`, before the existing per-type handling:

```rust
    if t.starts_with("agent.") {
        // Wire shape matches the server session protocol 1:1 — forward as-is.
        return serde_json::to_vec(&value).ok();
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test translate_frontend_passes_agent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git -C <worktree> add apps/desktop/src-tauri/src/noise_session.rs
/usr/bin/git -C <worktree> commit -m "feat(desktop): forward outbound agent.* frames to the noise session"
```

---

### Task 3: TS agent types

**Files:**
- Create: `apps/desktop/src/agent/agentTypes.ts`

**Interfaces:**
- Produces the shared type surface every later TS task imports. Port of the Swift types at `Agent/AgentMessage.swift` (`AgentToolCall` :7, `AgentBlock` :38, `AgentUsage` :51, `AgentMessage` :67, `AgentToolStyle` :105).

- [ ] **Step 1: Write the file**

```typescript
export type AgentRole = 'user' | 'assistant' | 'error';
export type AgentTurn = 'idle' | 'thinking' | 'streaming';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface AgentToolCall {
  id: string;
  name: string;
  summary: string;
  inputJson: string;
  result?: string;
  isError: boolean;
  diff?: DerivedDiff;
}

export interface DerivedDiff {
  path: string;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  lines: DiffLine[];
}

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
}

export type AgentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: AgentToolCall };

export interface AgentMessage {
  id: string;
  role: AgentRole;
  blocks: AgentBlock[];
  isStreaming: boolean;
  usage?: AgentUsage;
}

export interface AgentToolStyle {
  color: string;
  glyph: string;
}

/** name → style; mirror the mapping in Swift AgentMessage.swift:105. */
export function toolStyle(name: string): AgentToolStyle {
  switch (name) {
    case 'Edit':
    case 'Write':
      return { color: 'var(--agent-tool-edit)', glyph: '✎' };
    case 'Bash':
      return { color: 'var(--agent-tool-bash)', glyph: '$' };
    case 'Read':
      return { color: 'var(--agent-tool-read)', glyph: '◇' };
    default:
      return { color: 'var(--agent-tool-default)', glyph: '⚙' };
  }
}
```

(Match the exact case list + colors to Swift `AgentToolStyle` :105 when porting; the four above are the shape, not the final list.)

- [ ] **Step 2: Typecheck**

Run: `bun --cwd apps/desktop run typecheck` (or `bun lint`)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
bun format
/usr/bin/git -C <worktree> add apps/desktop/src/agent/agentTypes.ts
/usr/bin/git -C <worktree> commit -m "feat(desktop): agent chat type surface"
```

---

### Task 4: TS frame decode + outbound builders

**Files:**
- Create: `apps/desktop/src/agent/agentFrames.ts`
- Test: `apps/desktop/src/agent/agentFrames.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure).
- Produces:
  - `type AgentFrame` — discriminated union on `t`: `agent.delta {seq,text}`, `agent.tool {seq,id,name,summary,inputJson}`, `agent.tool_result {seq,id,result,isError}`, `agent.permission_req {seq,id,name,summary,inputJson}`, `agent.done {seq,usage?}`, `agent.error {seq,message}`.
  - `decodeAgentFrame(json: string): AgentFrame | null` — mirror Swift `NoiseSessionClient.swift:415` custom decoder.
  - Outbound builders returning objects to hand `sendJson`: `agentStart({id, cwd, sinceSeq})`, `agentPrompt(text)`, `agentInterrupt()`, `agentPermission({id, allow})`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'bun:test';
import { agentPrompt, agentStart, decodeAgentFrame } from './agentFrames';

describe('decodeAgentFrame', () => {
  it('decodes a delta', () => {
    const f = decodeAgentFrame('{"t":"agent.delta","seq":3,"text":"hi"}');
    expect(f).toEqual({ t: 'agent.delta', seq: 3, text: 'hi' });
  });
  it('returns null for non-agent frames', () => {
    expect(decodeAgentFrame('{"t":"output","chunk":"x"}')).toBeNull();
  });
});

describe('outbound builders', () => {
  it('start carries cwd + sinceSeq', () => {
    expect(agentStart({ id: 's1', cwd: '/tmp', sinceSeq: 4 })).toEqual({
      t: 'agent.start',
      id: 's1',
      cwd: '/tmp',
      sinceSeq: 4,
    });
  });
  it('prompt carries text', () => {
    expect(agentPrompt('go')).toEqual({ t: 'agent.prompt', text: 'go' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/desktop run test agentFrames`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `agentFrames.ts`**

```typescript
export type AgentFrame =
  | { t: 'agent.delta'; seq: number; text: string }
  | { t: 'agent.tool'; seq: number; id: string; name: string; summary: string; inputJson: string }
  | { t: 'agent.tool_result'; seq: number; id: string; result: string; isError: boolean }
  | { t: 'agent.permission_req'; seq: number; id: string; name: string; summary: string; inputJson: string }
  | { t: 'agent.done'; seq: number; usage?: { inputTokens: number; outputTokens: number; costUsd?: number } }
  | { t: 'agent.error'; seq: number; message: string };

export function decodeAgentFrame(json: string): AgentFrame | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  const t = v.t;
  if (typeof t !== 'string' || !t.startsWith('agent.')) return null;
  // Trust the server's shape; the union above documents each variant.
  return v as unknown as AgentFrame;
}

export function agentStart(input: { id: string; cwd: string; sinceSeq: number }) {
  return { t: 'agent.start' as const, id: input.id, cwd: input.cwd, sinceSeq: input.sinceSeq };
}
export function agentPrompt(text: string) {
  return { t: 'agent.prompt' as const, text };
}
export function agentInterrupt() {
  return { t: 'agent.interrupt' as const };
}
export function agentPermission(input: { id: string; allow: boolean }) {
  return { t: 'agent.permission' as const, id: input.id, allow: input.allow };
}
```

Cross-check the outbound field names against the Swift request builders `NoiseSessionClient.swift:326-337` and the server union `noiseSessionProtocol.ts:110-112`; adjust if the server expects different keys (e.g. `sinceSeq` casing).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/desktop run test agentFrames`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun format
/usr/bin/git -C <worktree> add apps/desktop/src/agent/agentFrames.ts apps/desktop/src/agent/agentFrames.test.ts
/usr/bin/git -C <worktree> commit -m "feat(desktop): agent frame decode + outbound builders"
```

---

### Task 5: Reducer core — deltas, done, error, usage

**Files:**
- Create: `apps/desktop/src/agent/agentChatModel.ts`
- Test: `apps/desktop/src/agent/agentChatModel.test.ts`

**Interfaces:**
- Consumes: `AgentFrame` (Task 4), `AgentMessage`/`AgentTurn`/`AgentUsage` (Task 3).
- Produces: `class AgentChatModel` (framework-agnostic, plain observable):
  - state: `messages: AgentMessage[]`, `turn: AgentTurn`, `lastSeq: number`, `revision: number`.
  - `apply(frame: AgentFrame): void` — the reducer.
  - `subscribe(fn: () => void): () => void` — notify on change (drives React via `useSyncExternalStore` in Task 8).
  - `snapshot()` — returns a stable object `{ messages, turn, lastSeq, revision }`.
  Ports Swift `AgentChatModel.apply` (`AgentChatModel.swift:146`), delta-coalescing behaviour and `lastSeq` tracking.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'bun:test';
import { AgentChatModel } from './agentChatModel';

describe('AgentChatModel core', () => {
  it('coalesces deltas into one streaming assistant message', () => {
    const m = new AgentChatModel();
    m.apply({ t: 'agent.delta', seq: 1, text: 'Hel' });
    m.apply({ t: 'agent.delta', seq: 2, text: 'lo' });
    const [msg] = m.snapshot().messages;
    expect(msg.role).toBe('assistant');
    expect(msg.blocks).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(msg.isStreaming).toBe(true);
    expect(m.snapshot().turn).toBe('streaming');
    expect(m.snapshot().lastSeq).toBe(2);
  });

  it('done finalizes streaming and records usage', () => {
    const m = new AgentChatModel();
    m.apply({ t: 'agent.delta', seq: 1, text: 'hi' });
    m.apply({ t: 'agent.done', seq: 2, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } });
    const s = m.snapshot();
    expect(s.messages[0].isStreaming).toBe(false);
    expect(s.messages[0].usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
    expect(s.turn).toBe('idle');
  });

  it('error appends an error message', () => {
    const m = new AgentChatModel();
    m.apply({ t: 'agent.error', seq: 1, message: 'boom' });
    const s = m.snapshot();
    expect(s.messages.at(-1)).toMatchObject({ role: 'error' });
    expect(s.turn).toBe('idle');
  });

  it('ignores frames at or below lastSeq (replay dedupe)', () => {
    const m = new AgentChatModel();
    m.apply({ t: 'agent.delta', seq: 5, text: 'a' });
    m.apply({ t: 'agent.delta', seq: 5, text: 'DUP' });
    expect(m.snapshot().messages[0].blocks).toEqual([{ type: 'text', text: 'a' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/desktop run test agentChatModel`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the reducer core**

```typescript
import type { AgentFrame } from './agentFrames';
import type { AgentMessage, AgentTurn, AgentUsage } from './agentTypes';

export interface AgentSnapshot {
  messages: AgentMessage[];
  turn: AgentTurn;
  lastSeq: number;
  revision: number;
}

export class AgentChatModel {
  private messages: AgentMessage[] = [];
  private turn: AgentTurn = 'idle';
  private lastSeq = 0;
  private revision = 0;
  private listeners = new Set<() => void>();
  private cached: AgentSnapshot | null = null;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): AgentSnapshot {
    if (!this.cached) {
      this.cached = {
        messages: this.messages,
        turn: this.turn,
        lastSeq: this.lastSeq,
        revision: this.revision,
      };
    }
    return this.cached;
  }

  private changed(): void {
    this.revision += 1;
    this.cached = null;
    for (const fn of this.listeners) fn();
  }

  private streamingAssistant(): AgentMessage {
    const last = this.messages.at(-1);
    if (last && last.role === 'assistant' && last.isStreaming) return last;
    const msg: AgentMessage = {
      id: `a${this.revision}-${this.messages.length}`,
      role: 'assistant',
      blocks: [],
      isStreaming: true,
    };
    this.messages = [...this.messages, msg];
    return msg;
  }

  apply(frame: AgentFrame): void {
    if (frame.seq <= this.lastSeq) return;
    this.lastSeq = frame.seq;
    switch (frame.t) {
      case 'agent.delta': {
        const msg = this.streamingAssistant();
        const blocks = [...msg.blocks];
        const tail = blocks.at(-1);
        if (tail && tail.type === 'text') {
          blocks[blocks.length - 1] = { type: 'text', text: tail.text + frame.text };
        } else {
          blocks.push({ type: 'text', text: frame.text });
        }
        this.replaceLast({ ...msg, blocks });
        this.turn = 'streaming';
        break;
      }
      case 'agent.done': {
        const last = this.messages.at(-1);
        if (last && last.isStreaming) {
          this.replaceLast({ ...last, isStreaming: false, usage: frame.usage as AgentUsage | undefined });
        }
        this.turn = 'idle';
        break;
      }
      case 'agent.error': {
        this.messages = [
          ...this.messages,
          { id: `e${this.lastSeq}`, role: 'error', blocks: [{ type: 'text', text: frame.message }], isStreaming: false },
        ];
        this.turn = 'idle';
        break;
      }
      default:
        // tool / tool_result / permission_req handled in Tasks 6 & 7.
        break;
    }
    this.changed();
  }

  protected replaceLast(msg: AgentMessage): void {
    this.messages = [...this.messages.slice(0, -1), msg];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/desktop run test agentChatModel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun format
/usr/bin/git -C <worktree> add apps/desktop/src/agent/agentChatModel.ts apps/desktop/src/agent/agentChatModel.test.ts
/usr/bin/git -C <worktree> commit -m "feat(desktop): agent reducer core (deltas/done/error)"
```

---

### Task 6: Reducer — tool cards + derived diff

**Files:**
- Modify: `apps/desktop/src/agent/agentChatModel.ts`
- Create: `apps/desktop/src/agent/agentDiff.ts` (LCS line diff, port of Swift `Agent/AgentDiff.swift` `unifiedLineDiff`)
- Test: `apps/desktop/src/agent/agentChatModel.test.ts` (extend), `apps/desktop/src/agent/agentDiff.test.ts`

**Interfaces:**
- Consumes: reducer core (Task 5), `AgentToolCall`/`DerivedDiff` (Task 3).
- Produces: `unifiedLineDiff(oldText: string, newText: string): DiffHunk[]`; reducer handles `agent.tool` (append a `tool` block) and `agent.tool_result` (attach result + `isError`, and for `Edit`/`Write` derive a diff from the tool `inputJson`).

- [ ] **Step 1: Write the failing tests**

```typescript
// agentDiff.test.ts
import { describe, expect, it } from 'bun:test';
import { unifiedLineDiff } from './agentDiff';
describe('unifiedLineDiff', () => {
  it('marks add and del', () => {
    const hunks = unifiedLineDiff('a\nb\n', 'a\nc\n');
    const kinds = hunks.flatMap((h) => h.lines.map((l) => l.kind));
    expect(kinds).toContain('add');
    expect(kinds).toContain('del');
    expect(kinds).toContain('context');
  });
});
```

```typescript
// add to agentChatModel.test.ts
it('tool then tool_result attaches result and diff for Edit', () => {
  const m = new AgentChatModel();
  m.apply({ t: 'agent.tool', seq: 1, id: 't1', name: 'Edit', summary: 'edit foo', inputJson: JSON.stringify({ file_path: '/foo', old_string: 'a', new_string: 'b' }) });
  m.apply({ t: 'agent.tool_result', seq: 2, id: 't1', result: 'ok', isError: false });
  const msg = m.snapshot().messages.at(-1)!;
  const block = msg.blocks.find((b) => b.type === 'tool');
  expect(block).toBeTruthy();
  if (block?.type === 'tool') {
    expect(block.tool.result).toBe('ok');
    expect(block.tool.diff?.path).toBe('/foo');
  }
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bun --cwd apps/desktop run test agentDiff agentChatModel`
Expected: FAIL.

- [ ] **Step 3: Implement `agentDiff.ts`** — port `unifiedLineDiff` from Swift `Agent/AgentDiff.swift` (LCS over lines → context/add/del `DiffLine[]` grouped in one `DiffHunk`). Return `DiffHunk[]`.

- [ ] **Step 4: Extend the reducer** — add `agent.tool` and `agent.tool_result` cases:

```typescript
      case 'agent.tool': {
        const msg = this.streamingAssistant();
        const tool = { id: frame.id, name: frame.name, summary: frame.summary, inputJson: frame.inputJson, isError: false };
        this.replaceLast({ ...msg, blocks: [...msg.blocks, { type: 'tool', tool }] });
        this.turn = 'thinking';
        break;
      }
      case 'agent.tool_result': {
        this.attachToolResult(frame.id, frame.result, frame.isError);
        break;
      }
```

Add a private `attachToolResult(id, result, isError)` that finds the matching tool block across messages, sets `result`/`isError`, and for `name === 'Edit' || 'Write'` parses `inputJson` (`old_string`/`new_string` or `content`) and sets `tool.diff = { path, hunks: unifiedLineDiff(old, next) }` via `derivedDiff` logic ported from Swift `AgentChatModel.swift:265`.

- [ ] **Step 5: Run to verify pass**

Run: `bun --cwd apps/desktop run test agentDiff agentChatModel`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun format
/usr/bin/git -C <worktree> add apps/desktop/src/agent/agentDiff.ts apps/desktop/src/agent/agentDiff.test.ts apps/desktop/src/agent/agentChatModel.ts apps/desktop/src/agent/agentChatModel.test.ts
/usr/bin/git -C <worktree> commit -m "feat(desktop): agent tool cards + derived diff"
```

---

### Task 7: Reducer — permission requests + prompt queue + draft

**Files:**
- Modify: `apps/desktop/src/agent/agentChatModel.ts`
- Test: `apps/desktop/src/agent/agentChatModel.test.ts` (extend)

**Interfaces:**
- Consumes: reducer (Tasks 5-6).
- Produces additional snapshot fields + methods (ported from Swift `AgentChatModel.swift` — `pendingApproval` + backlog, `draft`, `queued`):
  - snapshot gains: `pendingApproval: { id: string; name: string; summary: string } | null`, `queued: string[]`, `draft: string`.
  - `apply` handles `agent.permission_req` → set/queue `pendingApproval`.
  - `resolvePermission(allow: boolean): { id: string } | null` — pops the current approval, promotes the next from backlog, returns the id the caller should send `agentPermission` for.
  - `setDraft(text: string)`, `enqueue(text: string)`, `dequeue(): string | null`.

- [ ] **Step 1: Write the failing test**

```typescript
it('permission_req sets pendingApproval; resolve promotes backlog', () => {
  const m = new AgentChatModel();
  m.apply({ t: 'agent.permission_req', seq: 1, id: 'p1', name: 'Bash', summary: 'rm -rf', inputJson: '{}' });
  m.apply({ t: 'agent.permission_req', seq: 2, id: 'p2', name: 'Write', summary: 'x', inputJson: '{}' });
  expect(m.snapshot().pendingApproval?.id).toBe('p1');
  expect(m.resolvePermission(true)).toEqual({ id: 'p1' });
  expect(m.snapshot().pendingApproval?.id).toBe('p2');
});
```

- [ ] **Step 2-5:** run (fail) → implement the three snapshot fields, the `agent.permission_req` case (set if none pending else push to backlog), `resolvePermission`, `setDraft`/`enqueue`/`dequeue`, each calling `this.changed()` → run (pass).

Run: `bun --cwd apps/desktop run test agentChatModel`

- [ ] **Step 6: Commit**

```bash
bun format
/usr/bin/git -C <worktree> add apps/desktop/src/agent/agentChatModel.ts apps/desktop/src/agent/agentChatModel.test.ts
/usr/bin/git -C <worktree> commit -m "feat(desktop): agent permissions, prompt queue, draft"
```

---

### Task 8: `DrawerSession.kind` + React binding hook

**Files:**
- Modify: `apps/desktop/src/types.ts:20` (`DrawerSession`)
- Create: `apps/desktop/src/agent/useAgentChat.ts`
- Test: `apps/desktop/src/agent/useAgentChat.test.ts`

**Interfaces:**
- Consumes: `AgentChatModel` (Tasks 5-7), `coreTransport.ts` (`openNoiseSocket`, `sendJson`), `agentFrames.ts`.
- Produces:
  - `DrawerSession` gains `kind: string` (server serves `'pty'` | `'agent'`; default `'pty'` when absent so existing rows are unaffected).
  - `useAgentChat(hostId, sessionId, address)` — opens a Noise socket, routes `onMessage` through `decodeAgentFrame` → `model.apply`, sends `agentStart({ id: sessionId, cwd, sinceSeq: model.lastSeq })` on open, exposes `{ snapshot, send, model }` where `send` wraps `sendJson` with the outbound builders. Subscribes React via `useSyncExternalStore(model.subscribe, model.snapshot)`.

- [ ] **Step 1:** add `kind: string;` to `DrawerSession`. Find where `DrawerSession` is constructed from the Rust `SessionRow`/`core_sessions_list` payload and thread `kind` through (default `'pty'`). Write a test asserting a row without `kind` defaults to `'pty'` and one with `kind:'agent'` preserves it.
- [ ] **Step 2:** run (fail) → implement → run (pass): `bun --cwd apps/desktop run test`.
- [ ] **Step 3:** implement `useAgentChat` with `useSyncExternalStore`; test with a fake transport (inject an `openNoiseSocket`-shaped stub) that feeds a scripted `agent.delta` and asserts the hook's returned snapshot updates and that `agent.start` was sent with `sinceSeq: 0` on open.
- [ ] **Step 4:** run (pass).
- [ ] **Step 5: Commit**

```bash
bun format
/usr/bin/git -C <worktree> add apps/desktop/src/types.ts apps/desktop/src/agent/useAgentChat.ts apps/desktop/src/agent/useAgentChat.test.ts
/usr/bin/git -C <worktree> commit -m "feat(desktop): DrawerSession.kind + useAgentChat binding"
```

---

### Task 9: `ProseMarkdown` (react-markdown + remark-gfm)

**Files:**
- Modify: `apps/desktop/package.json` (add `react-markdown`, `remark-gfm`)
- Create: `apps/desktop/src/agent/ProseMarkdown.tsx`
- Test: `apps/desktop/src/agent/ProseMarkdown.test.tsx`

**Interfaces:**
- Consumes: existing `git/codeHighlight.ts` for fenced code.
- Produces: `<ProseMarkdown text={string} />` — renders GFM (tables, lists, headings, inline) via `react-markdown` + `remark-gfm`; a custom `code` renderer routes fenced blocks to the existing highlighter with horizontal-scroll containers.

- [ ] **Step 1:** `bun --cwd apps/desktop add react-markdown remark-gfm` (pin exact versions; verify they resolve under Bun).
- [ ] **Step 2:** write a render test: a GFM table string renders a `<table>` with the header cells; a fenced ```ts block renders highlighted code. (Use the desktop component test setup — mirror an existing `*.test.tsx`.)
- [ ] **Step 3:** run (fail) → implement `ProseMarkdown` with a `components={{ code: … }}` override calling `codeHighlight` → run (pass).
- [ ] **Step 4: Commit**

```bash
bun format
/usr/bin/git -C <worktree> add apps/desktop/package.json apps/desktop/src/agent/ProseMarkdown.tsx apps/desktop/src/agent/ProseMarkdown.test.tsx
/usr/bin/git -C <worktree> commit -m "feat(desktop): markdown prose rendering for agent chat"
```

(If the repo has a root lockfile, include it in the add.)

---

### Task 10: `AgentToolCard`

**Files:**
- Create: `apps/desktop/src/agent/AgentToolCard.tsx`
- Test: `apps/desktop/src/agent/AgentToolCard.test.tsx`

**Interfaces:**
- Consumes: `AgentToolCall`/`toolStyle` (Task 3), `git/DiffLines.tsx` for diff rendering.
- Produces: `<AgentToolCard tool={AgentToolCall} />` — glyph/color header from `toolStyle(tool.name)`, `summary`, optional `result` (error-styled when `isError`), and `tool.diff` rendered through `DiffLines`. Port of Swift `Views/AgentToolCard.swift`.

- [ ] **Step 1-4:** failing render test (renders name + glyph; renders diff lines when `diff` present; error styling when `isError`) → implement → pass → commit.

```bash
/usr/bin/git -C <worktree> commit -m "feat(desktop): agent tool card"
```

---

### Task 11: `AgentMessageRow`

**Files:**
- Create: `apps/desktop/src/agent/AgentMessageRow.tsx`
- Test: `apps/desktop/src/agent/AgentMessageRow.test.tsx`

**Interfaces:**
- Consumes: `AgentMessage` (Task 3), `ProseMarkdown` (Task 9), `AgentToolCard` (Task 10).
- Produces: `<AgentMessageRow message={AgentMessage} />` — user bubble / assistant turn / error bubble; renders each block in order (`text` → `ProseMarkdown`, `tool` → `AgentToolCard`); a usage footer (cost/tokens) when `message.usage`. Port of Swift `AgentMessageRow` (`AgentChatView.swift:256`) + `usageFooter`.

- [ ] **Step 1-4:** failing test (assistant with a text+tool block renders both in order; usage footer shows tokens when present) → implement → pass → commit.

```bash
/usr/bin/git -C <worktree> commit -m "feat(desktop): agent message row + usage footer"
```

---

### Task 12: `AgentComposer` (input + send/stop + queue + permission)

**Files:**
- Create: `apps/desktop/src/agent/AgentComposer.tsx`
- Test: `apps/desktop/src/agent/AgentComposer.test.tsx`

**Interfaces:**
- Consumes: reducer snapshot fields `draft`/`queued`/`turn`/`pendingApproval` and methods `setDraft`/`enqueue`/`resolvePermission` (Tasks 5-7), outbound `send` from `useAgentChat` (Task 8).
- Produces: `<AgentComposer send draft turn queued pendingApproval onDraft onEnqueue onResolvePermission />` — textarea ("Message Claude Code…"); Enter sends `agentPrompt` when idle else enqueues; the button is Send when `turn==='idle'` else Stop (`agentInterrupt`); queued rows; when `pendingApproval` is set, an Approve/Deny affordance that calls `onResolvePermission` then sends `agentPermission`. Port of Swift `AgentComposerView` (`AgentChatView.swift:188`) + `QueuedRow` + permission UI.

- [ ] **Step 1-4:** failing tests (Enter idle → send emits `agent.prompt`; Enter while streaming → enqueues; Stop button emits `agent.interrupt`; Approve emits `agent.permission {allow:true}`) → implement → pass → commit.

```bash
/usr/bin/git -C <worktree> commit -m "feat(desktop): agent composer with queue + permission approval"
```

---

### Task 13: `AgentFolderPicker`

**Files:**
- Create: `apps/desktop/src/agent/AgentFolderPicker.tsx`
- Test: `apps/desktop/src/agent/AgentFolderPicker.test.tsx`

**Interfaces:**
- Consumes: the session-less `fs` dir-list route (`apps/server/src/server/routes/fs.ts`) — check for an existing desktop fetch helper against `/api/fs` (bearer minted over Noise); reuse it, don't add a new transport.
- Produces: `<AgentFolderPicker onPick={(cwd: string) => void} onCancel />` — browse dirs, confirm a cwd. Port of Swift `Views/AgentFolderPicker.swift`.

- [ ] **Step 1-4:** failing test (lists dirs from a stubbed fetch; picking calls `onPick` with the path) → implement → pass → commit.

```bash
/usr/bin/git -C <worktree> commit -m "feat(desktop): agent chat folder picker"
```

---

### Task 14: `AgentChatPane` — assemble transcript + composer

**Files:**
- Create: `apps/desktop/src/agent/AgentChatPane.tsx`
- Test: `apps/desktop/src/agent/AgentChatPane.test.tsx`

**Interfaces:**
- Consumes: `useAgentChat` (Task 8), `AgentMessageRow` (Task 11), `AgentComposer` (Task 12).
- Produces: `<AgentChatPane hostId sessionId address />` — binds `useAgentChat`, renders the transcript (auto-follow scroll, jump-to-latest button when scrolled up, empty state) + `AgentComposer`. Port of Swift `AgentChatView` + `AgentTranscriptView` + `NearBottomTracker` (`AgentChatView.swift:10,68,167`).

- [ ] **Step 1-4:** failing test (mounts with a stub transport, renders an empty state, then an incoming `agent.delta` renders a message row; composer send routes through the hook) → implement → pass → commit.

```bash
/usr/bin/git -C <worktree> commit -m "feat(desktop): agent chat pane"
```

---

### Task 15: Wire into panes + new-chat entry + cross-device sync

**Files:**
- Modify: `apps/desktop/src/ResidentTerminals.tsx` (leaf render ~:131)
- Modify: `apps/desktop/src/SessionTabBar.tsx` (new-session entry)
- Modify: `apps/desktop/src/App.tsx` (new-chat flow: folder picker → start)
- Test: `apps/desktop/src/ResidentTerminals.test.tsx` (or nearest existing), `apps/desktop/src/agent/newChat.test.ts`

**Interfaces:**
- Consumes: `AgentChatPane` (Task 14), `DrawerSession.kind` (Task 8), `AgentFolderPicker` (Task 13), `agentStart` (Task 4).
- Produces: the end-to-end feature. This is the task that makes chats appear, open, and sync.

- [ ] **Step 1: Leaf render branch (failing test first).** Test: given a leaf whose session has `kind:'agent'`, `ResidentTerminals` mounts `AgentChatPane`; `kind:'pty'` (or absent) still mounts `TerminalPane`.

- [ ] **Step 2:** run (fail) → in `ResidentTerminals.tsx` at the leaf render (`:131`), branch:

```tsx
{session.kind === 'agent'
  ? <AgentChatPane hostId={session.hostId} sessionId={session.id} address={address} />
  : <TerminalPane … />}
```

→ run (pass).

- [ ] **Step 3: New-chat entry (failing test).** Test the new-chat flow function: picking a cwd sends `agent.start` with that cwd and `sinceSeq:0`, and the resulting session mounts in a pane. Keep the flow logic in a small pure helper (`newChat.ts`) so it is testable without the tab-bar UI.

- [ ] **Step 4:** run (fail) → add "New Agent Chat" beside "New Terminal" in `SessionTabBar.tsx`; on select, open `AgentFolderPicker` (in `App.tsx`), then create/open the agent session and send `agentStart({ id, cwd, sinceSeq: 0 })` → run (pass).

- [ ] **Step 5: Cross-device sync — explicit test.** Because the server is the source of truth, sync needs only two guarantees; assert both:
  1. A `DrawerSession` with `kind:'agent'` that this device did **not** create still renders as an openable chat (foreign-session discovery). Test: feed the session list a foreign `kind:'agent'` row → it appears and, when opened, mounts `AgentChatPane`.
  2. Opening any agent session sends `agent.start{ sinceSeq: model.lastSeq }` so the server replays the transcript. Test: on open with `lastSeq:0`, `agent.start` carries `sinceSeq:0`; after applying replayed frames up to seq 7, a re-open carries `sinceSeq:7`.

- [ ] **Step 6:** run (pass): `bun --cwd apps/desktop run test`.

- [ ] **Step 7: Full gate.** `bun lint` and `bun --cwd apps/desktop run test` and `cd apps/desktop/src-tauri && cargo test` all green.

- [ ] **Step 8: Commit**

```bash
bun format
/usr/bin/git -C <worktree> add apps/desktop/src/ResidentTerminals.tsx apps/desktop/src/SessionTabBar.tsx apps/desktop/src/App.tsx apps/desktop/src/agent/newChat.ts apps/desktop/src/agent/newChat.test.ts apps/desktop/src/ResidentTerminals.test.tsx
/usr/bin/git -C <worktree> commit -m "feat(desktop): mount agent chat panes, new-chat entry, cross-device sync"
```

---

## Self-Review

**Spec coverage:**
- Rust passthrough (spec §2) → Tasks 1-2. ✓
- TS transport + reducer (spec §3): types → T3; frames → T4; reducer (apply, coalesce, turn, permission, queue, draft, lastSeq, derived diff) → T5-7; `DrawerSession.kind` → T8. ✓
- React UI (spec §4): ProseMarkdown → T9; ToolCard → T10; MessageRow → T11; Composer → T12; FolderPicker → T13; ChatPane → T14. ✓
- Session creation + pane integration (spec §4) → T15. ✓
- Cross-device sync (spec §5): consume `kind` (T8 + T15 step 5.1), attach-with-replay `sinceSeq` (T8 + T15 step 5.2), drafts/queued local (T7, not synced). ✓
- Replay/reconnect (spec §6): `lastSeq` in reducer, `sinceSeq` on start → T5, T8, T15. ✓
- Testing (spec §7): Rust in/out (T1-2), reducer goldens (T5-7), component smoke (T9-15). ✓
- Risks (spec): resident-reducer bound — noted for T15 (eviction parity with terminals); permission affordance → T12; markdown re-parse mitigated by coalescing → T5/T9. ✓

**Placeholder scan:** UI Tasks 10-14 compress the TDD steps to a one-line "failing test → implement → pass" with the concrete assertion named and the Swift source anchor to port from; the load-bearing logic (Rust, frames, reducer) carries full code. No "TBD"/"handle edge cases"/vague steps remain.

**Type consistency:** `AgentFrame` variants (T4) match reducer `apply` cases (T5-7); `agentStart/agentPrompt/agentInterrupt/agentPermission` names consistent across T4, T8, T12, T15; `AgentChatModel` methods (`apply`, `subscribe`, `snapshot`, `resolvePermission`, `setDraft`, `enqueue`, `dequeue`) referenced consistently in T8/T12; `DrawerSession.kind` consistent T8/T15.
