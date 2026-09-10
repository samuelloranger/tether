# Desktop Agent-Chat — Design

**Date:** 2026-09-08
**Status:** Approved (design), pending spec review
**Board:** #1128
**Scope:** Port the agent-chat feature to `apps/desktop` at full parity with the shipped iOS client (`clients/apple`).

## Context

Agent chat is a Claude Code conversation that rides the **existing Noise session
socket** as `agent.*` JSON frames. A "chat" is a session with `kind='agent'` —
the same session primitive as a terminal, differing only in frame payloads.

- **Server** (`apps/server`) already implements the full feature: `agent.start /
  prompt / interrupt` inbound over the Noise session protocol
  (`noiseSessionProtocol.ts`), a driver that spawns the `claude` CLI
  (`agentClaudeDriver.ts`), a process-wide `sharedAgentRegistry` that survives
  client disconnect and fans frames to all attached sinks (`agentRegistry.ts`),
  and durable transcript storage in the `agent_messages` table keyed
  `(session_id, seq)` (`agentMessages.ts`, `db.ts`). `GET /api/sessions` already
  reports `kind`. **No server changes.**
- **iOS** keeps its decode + reducer **client-side in Swift**
  (`NoiseSessionClient.swift` decodes `agent.*`; `AgentChatModel.swift` is the
  reducer; `AgentChatView.swift` et al. render). The Rust core only does Noise
  crypto (opaque bytes). **No shared-core agent logic exists on either client.**
- **Desktop** is terminal-only. It has **zero** agent awareness: `DrawerSession`
  discards `kind`; `ResidentTerminals.tsx` mounts `TerminalPane` for every leaf;
  and the desktop Rust pump (`src-tauri/commands/noise.rs`) decodes into a typed
  `ServerMsg` enum and **silently drops** anything that is not
  `Output`/`Reset`/`Exit` — so `agent.*` frames currently fall into
  `ServerMsg::Other => {}` and vanish.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Delivery scope | **Full iOS parity** | User requirement. |
| Reducer home | **TS/React, client-side** (thin Rust passthrough) | Mirrors iOS's per-client Swift reducer; small contained Rust change; does not touch the shipped iOS client. Consolidating into `tether-core` would require rewriting the live iOS reducer + a stateful cross-FFI API — a separate spec, not this task. |
| Transport | **Rust forwards raw `agent.*` JSON untouched**; TS decodes/encodes | Rust stays a pipe, not a parser. |
| Entry point | **"New Agent Chat" in the session/tab bar → folder picker → pane** | Reuses existing pane/tab/split infra; chats tile alongside terminals. |
| Markdown | **`react-markdown` + `remark-gfm`** | Idiomatic React; GFM tables/lists/headings free; code fences handed to the existing highlighter; streaming-friendly. |
| Cross-device sync | **Server is source of truth; no new sync layer** | Transcript + live fan-out already server-side; desktop only needs to consume `kind` and attach-with-replay. |

## Data flow

Chat multiplexes over the per-host Noise session socket that is already open.

```
server agent.* JSON ──Noise──▶ desktop Rust pump ──raw JSON str──▶ webview event
                                                                       │
                                          agentFrames.ts (decode) ─────┤
                                                                       ▼
                                          AgentChatModel (TS reducer) ─▶ AgentChatPane (React)
TS composer ─▶ coreNoiseSend(agent.start/prompt/interrupt JSON) ─▶ translate_frontend ─▶ Noise ─▶ server
```

## Components

### 1. Rust passthrough — `apps/desktop/src-tauri/src/commands/noise.rs`

Minimal, no agent semantics in Rust.

- `decode_server`: add a `ServerMsg::Agent(String)` variant carrying the **raw
  JSON body** of any frame whose `t` starts with `agent.` (no field parsing).
- Pump loop (`noise.rs:640`): a new match arm emits the raw string to the webview
  — a dedicated event (`core-agent-{conn_id}`) so it never collides with the
  terminal output stream.
- `translate_frontend`: pass frontend `agent.start` / `agent.prompt` /
  `agent.interrupt` JSON straight through to `session.seal` (today it only knows
  terminal frames).
- Tests (`#[cfg(test)]`): (a) an inbound `agent.delta` frame is emitted verbatim,
  not dropped; (b) an outbound `agent.prompt` is sealed and sent.

### 2. TS transport + reducer — `apps/desktop/src/agent/` (new)

Pure logic, no React, fully unit-tested.

- `agentTypes.ts` — `AgentMessage` (role `user|assistant|error`, `blocks`,
  `isStreaming`, `usage`), `AgentBlock` (`text | tool`, interleaved in emit
  order), `AgentToolCall` (name, summary, inputJSON, result, isError, diff),
  `AgentUsage`, `AgentToolStyle` (name → color/glyph). Ports the Swift types.
- `agentFrames.ts` — wire frame union + `decodeAgentFrame(json)` mirroring the
  Swift `NoiseServerMessage` agent arms (`agent.delta / tool / tool_result /
  permission_req / done / error`, each with `seq`); outbound builders
  `agentStart({id, cwd, sinceSeq})`, `agentPrompt(text)`, `agentInterrupt()`,
  `agentPermission(reply)`.
- `agentChatModel.ts` — port of Swift `AgentChatModel`: state `messages`, `turn`
  (`idle | thinking | streaming`), `pendingApproval` + approval backlog, `draft`,
  `queued` prompts, `lastSeq`, `revision` (scroll trigger); `apply(frame)`
  reducer with delta coalescing and diff derivation from Edit/Write tool JSON
  (`unifiedLineDiff`). Framework-agnostic; the React layer subscribes.

`DrawerSession` (`apps/desktop/src/types.ts`) gains `kind: string` (server
already serves it; desktop discards it today). `SessionRef` is unchanged, so
`viewsSerialize.ts` needs no schema change.

### 3. React UI — `apps/desktop/src/agent/` (new)

Plain React (not xterm), reusing existing desktop primitives where they exist.

- `AgentChatPane.tsx` — top-level: transcript + composer, auto-follow scroll,
  jump-to-latest, empty state. Owns/binds one `AgentChatModel` instance.
- `AgentMessageRow.tsx` — user bubble / assistant turn / error bubble + usage
  footer (cost/tokens).
- `AgentToolCard.tsx` — console-style tool card: glyph/color from
  `AgentToolStyle`, result + diff. Diff rendering reuses `git/DiffLines.tsx`.
- `ProseMarkdown.tsx` — `react-markdown` + `remark-gfm`; fenced code blocks routed
  to the existing highlighter (`git/codeHighlight.ts`).
- `AgentComposer.tsx` — textarea ("Message Claude Code…") + send/stop, queued
  rows, permission approve/deny affordance.
- `AgentFolderPicker.tsx` — cwd chooser backed by the session-less `fs` dir-list
  route (`routes/fs.ts`).

### 4. Session creation + pane integration

- "New Agent Chat" entry beside "New Terminal" in the session/tab bar → opens
  `AgentFolderPicker` → sends `agent.start{cwd}` → the session mounts in a pane.
- `ResidentTerminals.tsx` (~line 131): branch the leaf render on `session.kind` —
  `'agent'` → `<AgentChatPane>`, otherwise `<TerminalPane>`. Chats split/tile
  with terminals via the unchanged pane tree.
- Reducer instances are keyed `"<hostId>:<sessionId>"` and kept **resident** like
  terminals, so backgrounded chats keep streaming. Eviction bounds live-reducer
  count the same way terminal eviction bounds live sockets.

### 5. Cross-device sync (server is source of truth — no new mechanism)

Because the transcript lives in `agent_messages` and `sharedAgentRegistry` fans
live frames to every attached sink, sync is inherent. Desktop's only obligations:

1. **Discover foreign chats.** Consuming `session.kind` makes agent sessions
   started on *any* device appear in the desktop drawer/session list.
2. **Attach-with-replay to any agent session**, not only desktop-created ones.
   Opening a drawer chat mounts the pane and sends `agent.start{sinceSeq:
   lastSeq}` (0 on first open) — the server replays rows with `seq > sinceSeq`,
   then streams live. Two devices on the same chat both receive live deltas via
   server fan-out.
3. **Not synced (by design, matching iOS):** local `draft` and `queued` prompts
   stay client-local.

`lastSeq` is held in reducer memory only — the same non-persistence caveat as the
terminal `sinceId` cursor (board #731). An app restart or a server `reset` drops
it and the next attach replays the whole retained transcript. Not solved here.

## Testing

- **Rust:** passthrough in (agent frame emitted verbatim) + out (agent frame
  sealed).
- **TS reducer (bulk):** golden `agent.*` frame sequences → asserted transcript
  state — streaming deltas coalesce, tool card + derived diff, permission
  request/approve/deny, done/usage, error, replay ordering by `seq`. Pure, no
  PTY, colocated `.test.ts`.
- **Component smoke:** pane mounts on `kind='agent'`; composer send emits
  `agent.prompt`; permission approve/deny path renders and replies.

## Risks

1. **Resident reducers multiply memory** — bound live-reducer count via the same
   eviction policy terminals use.
2. **Permission requests block the turn** — needs an unmistakable approve/deny
   affordance so a chat can't silently stall.
3. **react-markdown re-parse per streaming delta** — mitigated by the reducer's
   existing delta coalescing; parse the assembled text, not each chunk.

## Out of scope

- Server or `tether-core` changes.
- Consolidating the reducer into shared Rust (separate spec if dedup pain
  justifies it later).
- Persisting `lastSeq` across restarts (board #731).
