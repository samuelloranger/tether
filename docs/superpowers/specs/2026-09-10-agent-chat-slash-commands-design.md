# Agent chat: slash-command palette (+ /model, /resume)

**Date:** 2026-09-10
**Board task:** #1158
**Status:** Design approved, ready for implementation plan

## Summary

Add a slash-command palette to the agent-chat composer on both clients
(desktop TS + iOS Swift). Typing `/` raises a filtered, keyboard-navigable
popover over the input. Commands are two kinds: **local** UI verbs handled
client-side, and **agent** commands forwarded verbatim to the headless
`claude` CLI. Two local commands open sub-pickers: `/model` (switch the model
for the chat) and `/resume` (browse and reopen a past Claude Code session in a
new tab, with its history).

## Backend reality (assessed, not assumed)

The agent chat is driven by the real `claude` CLI in headless streaming mode,
spawned per prompt by `AgentClaudeDriver` (`apps/server/src/server/agentClaudeDriver.ts`):

```
claude --print --output-format stream-json --verbose --include-partial-messages \
  --dangerously-skip-permissions [--resume <sessionId>] -- <text>
```

- One `claude --print` per prompt. Continuity via `--resume <sessionId>`; the
  driver captures the session id + model from the CLI's init line.
- **No Claude API is used.** `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are
  stripped from the child env on purpose (`agentClaudeDriver.ts:206`) so turns
  run on the CLI's stored OAuth subscription login, never paid API billing.

Consequences that shaped the design:

- **`/model` needs no API and no tether update on model releases.** `claude
  --model <model>` accepts an alias ("latest of tier") or a full ID. Aliases
  (`sonnet`/`opus`/`haiku`/`opusplan`/`default`) resolve server-side to the
  latest model, so a new same-tier release is picked up automatically. A full
  model ID passes straight through. The CLI exposes no machine-readable model
  list (probed v2.1.267), so the alias set is a static client table plus a
  free-text "type a model ID" passthrough row.
- **`/resume` reads local disk, not an API.** Claude Code stores each session
  as `~/.claude/projects/<slug-of-cwd>/<uuid>.jsonl` on the server host (the
  machine running the CLI). Filename is the session UUID; the last-prompt line
  gives a label; mtime gives recency.

## Decisions (locked before design)

- **`/resume` opens a new tab** (not replace-this-tab). Avoids grafting a
  foreign transcript over the current chat's SQLite history. The new tab shows
  the picked session's history AND continues its context.
- **`/model` is a per-chat override that also becomes the host default** for
  new chats. One control, both scopes.
- **Model list = static aliases + free-text passthrough.** Never stale on
  release; escape hatch for any not-yet-aliased ID.
- **Agent-command half = curated built-ins + free passthrough.** Show a small
  curated list (`/compact`, `/init`, `/review`, `/commit`) for discovery, and
  forward any unlisted `/foo` verbatim. Per-project custom-command disk
  enumeration is out of scope for v1.
- **Registry lives per-client (Approach A)**, mirroring how `AgentChatModel` is
  already duplicated in TS and Swift rather than shared in the Rust core. The
  palette UI is per-platform anyway; only a ~10-row table + a fuzzy matcher is
  duplicated, kept in sync by this spec.

## Architecture

### Wire protocol

All palette logic is client-local except three additions to the sealed-JSON
`agent.*` frame set:

**Client → server:**
- `agent.model{ name: string }` — set this chat's model. Server stores it
  per-session and as the host default, and calls `driver.setModel(name)`. `name`
  is any alias or full ID.
- `agent.list-sessions{ cwd }` — request the `/resume` list. Explicit request
  (not pushed) so it is fetched only when the picker opens.
- `agent.start` gains one optional field `resumeClaudeSessionId?: string`, set
  only when a chat is spawned from `/resume`.

**Server → client:**
- `agent.sessions{ sessions: [{ id, label, mtimeMs, msgCount, cwd }] }` — the
  reply to `agent.list-sessions`.
- `agent.status` (exists) already carries the current model; the `/model`
  picker reads it. No new frame for the current-model value.

Unchanged: `agent.user`, `agent.delta`, `agent.tool`, `agent.tool_result`,
`agent.permission_req`, `agent.done`, `agent.error`.

### Client command dispatch (per client)

New pure, UI-free module: `apps/desktop/src/agent/agentCommands.ts` and
`clients/apple/TetherKit/Sources/TetherKit/Agent/AgentCommands.swift`.

**Command table** — static array, one entry each:
`{ id, trigger, kind: "local"|"agent", args?, glyph, desc, run? }`
- local: `/clear`, `/copy [last|all]`, `/retry`, `/model`, `/resume`
- agent (curated, tagged): `/compact`, `/init`, `/review [target]`, `/commit [msg]`

**Parser** — pure functions:
- `matchCommands(draft) → Command[]` — active only when `draft` starts with `/`
  and contains no space yet (a space closes the palette; the line then sends as
  a normal prompt). Prefix/substring filter, ranked.
- `dispatch(draft) → Action`, where `Action` is:
  - `local(cmd, args)` — handled in the model/view.
  - `agentText(text)` — forward verbatim as `agent.prompt` (curated agent
    commands AND unknown `/foo` passthrough).
  - `none` — not a command; normal prompt.

**Model/view wiring** — palette open/closed + selection index live in
`AgentChatModel` (both clients), so the two clients manage keyboard state
identically and it is covered by the existing model test suites. Composer key
handling gains: ↑↓ move, Tab completes the ghost, ↵ runs the highlighted
command (or dispatches the raw draft), Esc closes keeping the typed text.

Local actions reuse existing methods where possible: `/retry` → `retryLast()`;
`/clear` → new `clearTranscript()`; `/copy` → view clipboard; `/model` /
`/resume` → set a `pendingPicker` field the view renders.

### /model end-to-end

**Server:**
- `AgentClaudeDriver.setModel(name: string | null)` stores an override;
  `prompt()` appends `--model <name>` when set. `getModel()` still returns the
  CLI-reported model for `agent.status`.
- `agentRegistry.setModel(id, name)` routes to the entry's driver.
- `noiseSessionProtocol` handles `agent.model{name}`: `registry.setModel`,
  persist to the session row (per-chat) and `settings.agentDefaultModel`
  (config.ts, sticky host default), then re-emit `agent.status`.
- `applyAgentStart` seeds a new chat's model from `settings.agentDefaultModel`
  if set, before the first prompt.

**Migration:** add nullable `model` column to `sessions`; add
`agentDefaultModel` to the zod config schema. New `db.ts` migration entry
(never edit an applied one).

**Client:** `/model` sets `pendingPicker = model`. The view renders the picker
(alias rows + "type a model ID" free-text row), current alias checked from
`snapshot.status.model`. Selecting sends `agent.model{name}` and closes. The
type-an-ID row swaps the list for a one-line input; ↵ sends the typed string.

The alias strings live in the `agentCommands` module (per client); their
descriptions are cosmetic.

### /resume with history

**New pure module `apps/server/src/server/claudeSessions.ts`:**
- `slugForCwd(cwd)` — replicate Claude Code's project-dir slug: leading `/` and
  every `/` become `-` (verified on host: `~/sites/tether` →
  `-home-samuelloranger-sites-tether`).
- `listClaudeSessions(cwd)` — read `~/.claude/projects/<slug>/*.jsonl`; per
  file: `id` = basename minus `.jsonl`, `mtimeMs` = stat, `msgCount` ≈ line count,
  `label` = last user-message text (walk `last-prompt` leafUuid, else first user
  line). Sort mtime desc, cap ~50. Pure over an injected fs for fixture tests.
- `translateSessionJsonl(path) → AgentMessageRow[]` — parse the persisted
  `.jsonl` (richer than `--print` stream-json: `parentUuid`, `message` wrapper,
  content-block arrays) and map each event to a stored frame:
  - user message text → `agent.user`
  - assistant text block → `agent.delta`
  - assistant `tool_use` → `agent.tool`
  - user-side `tool_result` → `agent.tool_result`
  - per-turn usage/result → `agent.done`
  - skip sidechains, meta, hook attachments, system/init lines.
  - Byte-budgeted (reuse the replay tail budget) and capped to the last N turns;
    older turns dropped behind a leading marker row.
  - Tolerant: unknown line types are skipped, never throw.

**Resume spawn flow (`applyAgentStart`):**
1. New tether session with `resumeClaudeSessionId` present →
   `translateSessionJsonl(<slug>/<uuid>.jsonl)`.
2. Persist the translated rows under the **new** tab's session id with fresh
   seqs (existing insert path), then `createAgentSession`.
3. Start the driver seeded with `--resume <uuid>` (first `prompt()` already
   appends `--resume <sessionId>`).
4. Standard replay streams the persisted history to the client; live continues.

**Client — new-tab spawn:** `/resume` sets `pendingPicker = resume` and fires
`agent.list-sessions{cwd}` on the current chat's socket. The picker renders
`agent.sessions` rows (label, relative time, msg count, `⌂` when `cwd` differs
from this chat's). Selecting calls the existing new-tab path — iOS
`newAgentChat(hostId, cwd, resumeSessionId:)`, desktop equivalent — threading
`resumeClaudeSessionId` into that tab's `agent.start`. The current chat is
untouched.

**No jsonl→frame translation on the client**: history renders through the same
replay path a reconnect uses.

## Error handling

- `translateSessionJsonl` on an empty/corrupt/missing file → empty history, no
  throw; the new tab simply opens with no prior turns and still `--resume`s.
- Unknown/newer jsonl line shapes are skipped, not fatal (CLI-version drift).
- `agent.list-sessions` for a cwd with no project dir → empty list; the picker
  shows an empty state, not an error.
- `agent.model` with an unusable alias/ID: the CLI errors on the next spawn and
  the existing `agent.error` path surfaces it; the stored override remains and
  can be changed again.

## Testing

- **Server pure:** `agentCommands` matcher/dispatch; `claudeSessions` (slug,
  list, translate — fixture jsonl); driver `--model`/`--resume` arg assembly;
  registry `setModel`; config migration.
- **Server integration:** `noiseSessionProtocol` handlers for `agent.model`,
  `agent.list-sessions`, and resume `agent.start` (FakeAgentDriver + fixture
  fs) — assert emitted frames + persistence.
- **Desktop:** `agentCommands` matcher; `AgentChatModel` palette state
  (open/select/Tab/Esc); picker submit → outbound frame. bun:test.
- **iOS:** `AgentCommands` + `AgentChatModel` palette/picker in `TetherKitTests`
  (XCTest). No XCUITest E2E in v1.

**Gates:** `bun lint`; `bun --cwd apps/server run test`; `bun --cwd apps/desktop
run test`; iOS `xcodebuild test` on macbuild. `cargo test` only if the
noise_session passthrough is touched (expected untouched — new frames pass
through generically).

## Rollout

Single release, built in de-risking order:
1. Wire frames + `agentCommands` (both clients) + palette UI → local commands.
2. `/model` server + picker.
3. `/resume` list + `translateSessionJsonl` + resume spawn + picker.
4. Full lint/test/typecheck green → one release via `releasing-tether`.

## Out of scope (follow-ups)

- Per-project custom-command disk enumeration (`.claude/commands`, skills).
- XCUITest E2E for the palette.
- "Load more history" beyond the translate cap.
- A model badge per tab in the drawer.

## Risks

- **`translateSessionJsonl` is the biggest, most drift-prone unit.** The
  persisted jsonl shape changes across CLI versions. Mitigation: fixture-driven
  tests with a real redacted `.jsonl` from this host, tolerant parsing, a hard
  cap so pathological files degrade gracefully.
- **History/live seam on resume:** the translated history and the first live
  turn must order correctly (seqs). Covered by the resume integration test.
