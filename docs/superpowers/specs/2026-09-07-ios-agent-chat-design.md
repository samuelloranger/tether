# iOS Agent Chat — Design Spec

**Date:** 2026-09-07
**Status:** Draft for review
**Scope:** iOS-only native "agent chat" — talk to Claude Code from the Tether iOS app.

---

## 1. Summary

A native SwiftUI chat surface in the Tether iOS app that drives a server-side
Claude Code agent. The user starts a chat pinned to a workspace folder, sends
prompts, and sees streamed replies with markdown, syntax-highlighted code, and
tool-use cards. File-mutating tools (`Edit`/`Write`/`Bash`) prompt for approval
on the phone. The transcript persists on the server and replays on reconnect,
matching how PTY sessions already survive disconnects.

A working proof of concept exists (a present-page iframe fed by
`apps/server/src/server/presentChat.ts` over `POST /preview/:token/chat`). This
spec supersedes it with a first-class native feature. The POC code is throwaway
once P1 lands.

### Non-goals

- Desktop client. The desktop Rust frame parser tolerates unknown frames
  (`crates/tether-core/src/protocol.rs` `#[serde(other)] Unknown`), so the new
  `agent.*` frames are simply ignored there. A desktop surface can come later.
- Replacing the PTY terminal. Agent chat is a **sibling** session kind, not a
  reshape of terminals.
- Multi-agent / subagent visualization, cost dashboards, prompt templates. Later
  if ever.

---

## 2. Decisions (locked)

| Fork | Decision |
|---|---|
| Transport | Native over the existing sealed Noise channel; new `agent.*` message types. Not the POC's token-authed SSE. |
| Runner | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) `query()` in streaming-input mode — NOT `claude --print -p`. Rationale below. |
| Auth | Subscription (the SDK drives the installed `claude` login; `ANTHROPIC_API_KEY` stays unset on the daemon). |
| Tool permissions | Approve on phone via the SDK's `canUseTool` callback bridged to an iOS sheet. |
| Persistence | Server SQLite `agent_messages` table; replay on reconnect like `terminal_logs`. |
| Working dir | User browses the existing workspace file tree to pick the chat's `cwd`. |
| Sessions | Multiple concurrent agent sessions; new `kind` discriminator; separate registry. |
| Markdown | Hand-rolled block split reusing the existing highlighter (P1); `swift-markdown-ui` as a documented fallback. |

### Why the Agent SDK, not `claude --print`

`claude --print -p` is one-shot and non-interactive: it cannot pause mid-run to
ask the phone whether a tool may run, which is the whole point of on-phone
approval. The Claude Agent SDK's `query()` runs the agent loop with a
`canUseTool` callback (suspend → ask → resume) and emits a structured message
stream, removing the POC's line-by-line NDJSON parsing. It spawns the same
`claude` binary under the hood, so subscription auth is preserved. The Agent SDK
is a distinct package from the Anthropic API SDK; its exact `query()` options and
`canUseTool` signature MUST be read from the Agent SDK docs
(`code.claude.com/docs/en/agent-sdk`) at implementation time — do not guess them.

---

## 3. Architecture overview

```
iOS SwiftUI (AgentChatView, AgentChatStore)
        ↕  sealed Noise JSON  { t: 'agent.*' }
   NoiseSessionClient (Swift)  ⟷  noiseSessionProtocol.ts (server)
        ↕
   agentRegistry.ts  — one AgentSession per chat
        ↕  Claude Agent SDK query() + canUseTool
   claude (subscription login)  in the chosen workspace cwd
        ↕
   agent_messages (SQLite)  — append every frame; replay on reconnect
```

Two existing seams are reused wholesale: the Noise channel (encryption, IK
reconnect auth, `auth.token` minting) and the replay-cursor pattern
(`sinceId`/`pruned_before`/`reset`). Everything else is additive.

---

## 4. Server

### 4.1 Session model

- **DB (`db.ts`):** add migration appending a `kind TEXT NOT NULL DEFAULT 'pty'`
  column to `sessions` (`'pty' | 'agent'`). Agent rows reuse the existing
  `workspace_root` column for `cwd`. Never edit an applied migration — append a
  new entry to the `migrations` array.
- **Registry:** new `agentRegistry.ts` holding `Map<sessionId, AgentSession>`.
  The PTY `SessionInstance` (`ptyHolder.ts`) is hard-wired to a holder socket and
  is NOT reused. `AgentSession` owns: the Agent SDK `query` handle, the current
  turn's abort controller, the per-session `allow_always` tool set, and the
  monotonic `seq` counter.
- **List API (`routes/sessions.ts`):** `GET /api/sessions` includes `kind`.
  Agent sessions report `activity` from turn state (`working` while a turn runs,
  `waiting` while a permission request is outstanding, `idle` otherwise) rather
  than PTY byte heuristics.

### 4.2 Wire protocol (`agent.*`, sealed Noise)

Hand-maintained in `noiseSessionProtocol.ts` (TS) and `NoiseSessionClient.swift`
(Swift). Rust `ServerFrame`/`ClientFrame` need no change (unknown frames tolerated).

Client → server:

| Message | Fields | Meaning |
|---|---|---|
| `agent.start` | `id, cwd, sinceSeq?` | Open/resume a chat session in `cwd`; replay after `sinceSeq`. |
| `agent.prompt` | `text` | User turn. |
| `agent.permission` | `reqId, decision('allow'\|'deny'\|'allow_always')` | Answer a pending tool request. |
| `agent.interrupt` | — | Abort the running turn. |

Server → client:

| Message | Fields | Meaning |
|---|---|---|
| `agent.delta` | `seq, text` | Streamed assistant text chunk. |
| `agent.tool` | `seq, name, input` | A tool call (post-approval, or auto-run tool). |
| `agent.tool_result` | `seq, text, isError` | Tool output (truncated). |
| `agent.permission_req` | `reqId, name, input` | Tool needs approval; UI shows a sheet. |
| `agent.done` | `seq, cost, usage` | Turn finished. |
| `agent.error` | `message` | Turn failed. |
| `reset` | (existing) | Replay cursor stale → client clears and takes the full tail. |

`seq` is the persistence cursor (see 4.4). `reqId` is a per-session monotonic id
for pairing a request with its answer.

### 4.3 Runner (`agentRunner.ts`)

- Wrap Agent SDK `query()` per session in streaming-input mode; feed each
  `agent.prompt` as a user turn; keep the session alive across turns (no
  re-spawn — the SDK holds context; no `--resume` juggling).
- Map SDK stream events → `agent.*` frames: assistant text deltas → `agent.delta`;
  tool-use start → `agent.tool`; tool result → `agent.tool_result`; turn end →
  `agent.done`.
- `canUseTool(toolName, input)`:
  1. If `(session, toolName)` is in `allow_always`, resolve allow.
  2. Else emit `agent.permission_req`, park a promise keyed by `reqId`.
  3. On matching `agent.permission`: `allow`/`allow_always` → resolve allow (and
     record for `allow_always`); `deny` → resolve deny with a short reason.
  - A disconnect while parked: leave parked; on reconnect the client re-shows
    outstanding requests (replayed from persistence). A killed session rejects
    all parked promises.
- `agent.interrupt` → abort the current turn via the SDK's interrupt/abort path.
- Keep all event-mapping logic pure and colocated-testable (lift the POC's
  `mapClaudeLine` shape into a pure mapper with a `.test.ts` sibling).

### 4.4 Persistence & replay

- New table:
  `agent_messages(session_id TEXT, seq INTEGER, role TEXT, kind TEXT, text TEXT, tool_json TEXT, ts INTEGER, PRIMARY KEY(session_id, seq))`.
  `kind` ∈ `delta|tool|tool_result|permission_req|done|error|user`.
- Every emitted frame (and each user prompt) is appended with the next `seq`
  before/as it is broadcast. Deltas may be coalesced per assistant turn to keep
  row counts sane (append-on-flush, e.g. per sentence or on `agent.done`).
- Cap + prune per session like `terminal_logs` (`pruned_before` analog); on
  `agent.start` with `sinceSeq < pruned_before`, send `reset` then the full
  retained tail.
- Reconnect replays **completed** frames only; an in-flight turn then continues
  streaming live. An outstanding `permission_req` is part of the replayed tail,
  so the approval sheet reappears after reconnect.

### 4.5 Security

- The agent runs `claude` on the host with real tool access. All `agent.*`
  traffic rides the authenticated Noise channel (per-device, already the auth
  boundary) — no new unauthenticated surface, unlike the POC's preview-token
  route. The POC route (`/preview/:token/chat`) is removed when P1 ships.
- On-phone approval is the guard against destructive tools; `allow_always` is
  per-session and in-memory (never persisted), so it never silently widens across
  restarts.
- Keep the standing posture: run Tether behind a tunnel / LAN. File and shell
  write access via an agent is strictly more powerful than the terminal already
  is, but not a new class of exposure on an already-paired device.

---

## 5. iOS client

### 5.1 State

- `AgentChatStore` (`@Observable`, main-actor) per session: `messages:
  [AgentMessage]`, `turnState`, `pendingApproval?`. Streams `agent.delta` into
  the last assistant message's text only, so SwiftUI re-renders one bubble.
- `NoiseServerMessage` (Swift) gains `agent.*` decode cases; the
  `TerminalPipeline`-style read loop dispatches them to the store.
- Reuse the host/session cache-key convention `"<hostId>:<sessionId>"`.

### 5.2 Views

- **`AgentChatView`** — `ScrollView` + `LazyVStack` + `ForEach` +
  `ScrollViewReader` (pattern from `GitReviewView`). Auto-scroll via
  `.onChange(of:)` on message count / last-text length calling `scrollTo(bottomID)`
  — never inline in the same update (SwiftUI can't scroll to an item added in the
  same pass). Test scroll/gesture behavior on device (iOS 26 regressions noted).
- **Message bubble** — user vs assistant; streaming caret on the live bubble.
- **Markdown rendering** — hand-rolled block split: parse a message into prose
  and fenced-code blocks. Prose → `Text(AttributedString(markdown:))` (inline
  styles only — bold/italic/inline-code/links). Code blocks → reuse
  `HighlightedCodeText` + `CodeLanguage`. Light manual styling for lists/headings.
  SwiftUI's native markdown does NOT render code blocks/tables/lists, which is why
  the split is necessary. **Fallback:** adopt `swift-markdown-ui` (MarkdownUI SPM)
  if lists/tables/headings prove fiddly — full block rendering, one dependency.
- **Tool card** — collapsible; header = tool name + one-line summary; body =
  input. `Edit`/`Write` inputs render as a diff by reusing `DiffModel` +
  `SideBySideDiffView`. `agent.tool_result` attaches under its card.
- **Approval sheet** — on `pendingApproval`: tool name + input (diff for edits),
  buttons Deny / Allow / Allow for this chat. Sends `agent.permission`.
- **Folder picker** — starting a new chat opens the existing workspace
  file-tree/dir browser; the chosen dir becomes `cwd` in `agent.start`.
- **Drawer** — `SessionDrawerView` branches on `kind`: chat glyph for agent
  sessions, grouped under their host like PTY sessions.

### 5.3 Rendering references

- Streaming + `@Observable` re-render scoping: dev.to "Real-Time AI Chat UI with
  SwiftUI".
- Auto-scroll patterns + same-update gotcha: Itsuki "Reliable ways to scroll to
  the bottom".
- Native markdown limits (no code blocks/tables): SwiftLee "Markdown Text in
  SwiftUI"; fatbobman "SwiftUI Rich Text Layout".
- Full-featured fallback: `swift-markdown-ui`.

---

## 6. Phasing

- **P1 — Working native chat.** Session `kind` + `agentRegistry` + `agent.*`
  protocol (TS + Swift) + runner with tools auto-approved (`canUseTool` always
  allows, no sheet yet) + bubbles, streaming deltas, hand-rolled markdown/code,
  folder picker, drawer branch. Remove the POC route.
- **P2 — Persistence & replay.** `agent_messages` table, append-on-emit, replay
  on `agent.start`, prune + `reset`.
- **P3 — Tool approval.** `canUseTool` → `agent.permission_req` → sheet →
  `agent.permission`; `allow_always`; parked-request survival across reconnect.
- **P4 — Polish.** Diff tool cards, `agent.interrupt`, activity/title in the
  drawer, error states, empty state.

Each phase ships independently and leaves the app working.

---

## 7. Testing

- **Server (bun:test, colocated):** pure event-mapper (SDK event → `agent.*`
  frame) with a `.test.ts` sibling; replay planner (sinceSeq → frames, stale →
  reset) tested without a live agent; registry lifecycle (start/kill/parked-promise
  rejection). Keep pure logic in its own module, PTY-free.
- **Swift:** `NoiseServerMessage` decode cases for each `agent.*` frame; the
  `AgentChatStore` reducer (delta coalescing into the live bubble, approval
  state); the markdown block splitter (prose vs fenced code). Follow the existing
  `NoiseAuthTokenTests` / decode-test patterns.
- **Manual/device:** streaming smoothness, auto-scroll on device (iOS 26),
  approval round-trip, reconnect mid-turn.

---

## 8. Open risks

1. **Agent SDK API surface.** `query()` streaming-input options and the exact
   `canUseTool` signature/return shape must be confirmed against the Agent SDK
   docs at build time. If `canUseTool` cannot be used the way assumed, fall back
   to `claude --print --permission-prompt-tool <in-process MCP>` — a documented
   alternative that also bridges approval, at the cost of NDJSON parsing.
2. **Subscription auth headless.** Verify the Agent SDK, spawned by the daemon,
   picks up the CLI login with `ANTHROPIC_API_KEY` unset. The POC already proved
   `claude` itself does; confirm the SDK path matches.
3. **Delta row volume.** Persisting every token delta is too many rows — coalesce
   before append (per sentence / on turn end). Get this right in P2, not P1.
4. **Markdown scope creep.** The hand-rolled renderer covers prose + code + light
   lists. If agent output leans on tables/nested lists, switch to
   `swift-markdown-ui` rather than growing the hand-roll.
5. **Hook inheritance.** The daemon-spawned agent inherits the host's global
   Claude Code hooks. Decide whether to run it with a clean hook config so the
   user's personal hooks don't perturb the chat agent.

---

## 9. Reused code index

| Need | Reuse | File |
|---|---|---|
| Sealed transport, reconnect auth | Noise channel | `noiseSessionProtocol.ts`, `NoiseSessionClient.swift` |
| Replay cursor pattern | `sinceId`/`pruned_before`/`reset` | `db.ts`, `routes/sessions.ts`, `TerminalPipeline.swift` |
| Syntax highlighting | `HighlightedCodeText`, tokenizer | `Views/CodeHighlightView.swift`, `Terminal/CodeLanguage.swift` |
| Diff rendering | `DiffModel`, side-by-side | `Terminal/DiffModel.swift`, `Views/SideBySideDiffView.swift` |
| List/scroll pattern | ScrollView + LazyVStack + ForEach | `Views/GitReviewView.swift`, `Views/SessionDrawerView.swift` |
| Event-mapping shape | POC `mapClaudeLine` | `apps/server/src/server/presentChat.ts` (throwaway) |
