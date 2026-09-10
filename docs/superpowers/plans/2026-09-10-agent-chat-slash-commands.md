# Agent Chat Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a slash-command palette to the agent-chat composer on desktop and iOS, with `/model` (switch model) and `/resume` (reopen a past Claude Code session in a new tab, with history).

**Architecture:** All palette logic is client-local except three additions to the sealed-JSON `agent.*` frame set. The command table + matcher is duplicated per client (mirroring how `AgentChatModel` is already duplicated), not shared in the Rust core. `/model` adds a `--model` flag to the server's `claude --print` spawn; `/resume` reads the server host's `~/.claude/projects/<slug>/*.jsonl`, translates a picked session into stored agent frames under a new tab's id, and seeds the driver with `--resume`.

**Tech Stack:** Bun + Hono + bun:sqlite (server), React + TypeScript + xterm.js (desktop), Swift/SwiftUI (iOS). Tests: bun:test (server/desktop), XCTest (iOS).

**Spec:** `docs/superpowers/specs/2026-09-10-agent-chat-slash-commands-design.md`

## Global Constraints

- **No Claude API.** The agent driver runs `claude --print` on OAuth login; `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are stripped (`agentClaudeDriver.ts:206`). Nothing in this feature may add an API key path.
- **Bun ≥ 1.3.14** floor (PTY API). Dev/CI on 1.4.x.
- **Migrations are append-only.** New schema = a new entry in the `migrations` array in `db.ts` (next is `version: 13`). Never edit an applied migration.
- **`bun:sqlite` uses `$name` named params.**
- **Tests colocated** (`foo.ts` + `foo.test.ts`). Keep pure logic in its own module so it's testable without a PTY.
- **Run `bun --cwd apps/server run test`** (not `bun test`) so the `--parallel` flag applies. Never pin `TETHER_DB_PATH` for a suite.
- **Formatting is Biome:** 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before committing.
- **Comments minimal** — only a non-obvious "why".
- **Model list is static aliases + free-text passthrough.** No enumeration; aliases (`sonnet`/`opus`/`haiku`/`opusplan`/`default`) auto-track releases; full IDs pass through.
- **Single release** at the end via the `releasing-tether` skill.

---

## File Structure

**Server (`apps/server/src/server/`):**
- `agentClaudeDriver.ts` (modify) — add `setModel`, `seedResume`; extract pure `buildClaudeArgs`.
- `agentDriver.ts` (modify) — extend `AgentDriver` interface (`setModel?`, `seedResume?`); extend `FakeAgentDriver` for tests.
- `agentRegistry.ts` (modify) — `setModel(id,name)`; `start(id,cwd,opts?)`.
- `claudeSessions.ts` (create) — `slugForCwd`, `listClaudeSessions`, `translateSessionJsonl`.
- `db.ts` (modify) — migration v13 (`sessions.model` column); `setSessionModel`/read via `getSession`.
- `config.ts` (modify) — `agent.defaultModel` setting.
- `noiseSessionProtocol.ts` (modify) — message types + `agent.model`/`agent.list-sessions` handlers.
- `agentReplay.ts` (modify) — `applyAgentStart` resume translation + default-model seeding.
- Tests: `claudeSessions.test.ts`, `agentClaudeDriver.test.ts` (extend), `agentRegistry.test.ts` (extend), `config.test.ts` (extend), `noiseSessionProtocol.test.ts` (extend).

**Desktop (`apps/desktop/src/agent/`):**
- `agentCommands.ts` (create) — table + `matchCommands` + `dispatchDraft`.
- `agentChatModel.ts` (modify) — palette/picker state into `AgentSnapshot`.
- `agentFrames.ts` (modify) — `agentModel`, `agentListSessions` builders; `resumeClaudeSessionId` on `agentStart`; `agent.sessions` in union.
- `AgentComposer.tsx` (modify) — palette popover + key handling.
- `AgentModelPicker.tsx`, `AgentResumePicker.tsx` (create) — pickers.
- `useTetherDesktop.tsx` / `App.tsx` / `ResidentTerminals.tsx` (modify) — thread `resumeSessionId` into a new agent tab.
- `index.css` (modify) — palette + picker styles.
- Tests: `agentCommands.test.ts`, `agentChatModel.test.ts` (extend), `agentFrames.test.ts` (extend).

**iOS (`clients/apple/TetherKit/Sources/TetherKit/`):**
- `Agent/AgentCommands.swift` (create) — table + `matchCommands` + `dispatchDraft`.
- `Agent/AgentChatModel.swift` (modify) — palette/picker state + `AgentOutbound.model`/`.listSessions`; apply `agent.sessions`.
- `Views/AgentChatView.swift` (modify) — palette list + picker sheets.
- `SessionStore.swift` (modify) — `routeAgentOutbound` new cases; `newAgentChat(...,resumeSessionId:)`.
- `Terminal/TerminalPipeline.swift` + `Noise/NoiseSessionClient.swift` (modify) — outbound frames.
- Tests: `Tests/TetherKitTests/AgentCommandsTests.swift`, extend `AgentChatModel` tests.

---

## PHASE 1 — Wire protocol + client command core (local commands)

### Task 1: Client command module (desktop)

**Files:**
- Create: `apps/desktop/src/agent/agentCommands.ts`
- Test: `apps/desktop/src/agent/agentCommands.test.ts`

**Interfaces:**
- Produces: `AgentCommand` type; `AGENT_COMMANDS: AgentCommand[]`; `matchCommands(draft: string): AgentCommand[]`; `dispatchDraft(draft: string): DispatchResult`.
  - `AgentCommand = { id: string; trigger: string; kind: 'local' | 'agent'; args?: string; glyph: string; desc: string }`
  - `DispatchResult = { type: 'local'; id: string; args: string } | { type: 'agentText'; text: string } | { type: 'none' }`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/agent/agentCommands.test.ts
import { describe, expect, test } from 'bun:test';
import { AGENT_COMMANDS, dispatchDraft, matchCommands } from './agentCommands';

describe('matchCommands', () => {
  test('bare slash returns all commands', () => {
    expect(matchCommands('/')).toEqual(AGENT_COMMANDS);
  });
  test('filters by substring after the slash', () => {
    const ids = matchCommands('/co').map((c) => c.id);
    expect(ids).toContain('copy');
    expect(ids).toContain('compact');
    expect(ids).not.toContain('clear');
  });
  test('a space closes the palette (no matches)', () => {
    expect(matchCommands('/model sonnet')).toEqual([]);
  });
  test('non-slash draft never matches', () => {
    expect(matchCommands('hello')).toEqual([]);
  });
});

describe('dispatchDraft', () => {
  test('known local command → local action with args', () => {
    expect(dispatchDraft('/copy all')).toEqual({ type: 'local', id: 'copy', args: 'all' });
  });
  test('known agent command → forwarded text verbatim', () => {
    expect(dispatchDraft('/compact')).toEqual({ type: 'agentText', text: '/compact' });
  });
  test('unknown slash command → forwarded verbatim (passthrough)', () => {
    expect(dispatchDraft('/wibble x')).toEqual({ type: 'agentText', text: '/wibble x' });
  });
  test('plain text → none', () => {
    expect(dispatchDraft('hello there')).toEqual({ type: 'none' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/desktop run test agentCommands`
Expected: FAIL — module `./agentCommands` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/agent/agentCommands.ts
export interface AgentCommand {
  id: string;
  trigger: string;
  kind: 'local' | 'agent';
  args?: string;
  glyph: string;
  desc: string;
}

export type DispatchResult =
  | { type: 'local'; id: string; args: string }
  | { type: 'agentText'; text: string }
  | { type: 'none' };

export const AGENT_COMMANDS: AgentCommand[] = [
  { id: 'clear', trigger: '/clear', kind: 'local', glyph: '⌫', desc: 'Start a fresh conversation' },
  { id: 'copy', trigger: '/copy', kind: 'local', args: '[last|all]', glyph: '⧉', desc: 'Copy the transcript to clipboard' },
  { id: 'retry', trigger: '/retry', kind: 'local', glyph: '↻', desc: 'Resend the last prompt' },
  { id: 'model', trigger: '/model', kind: 'local', glyph: '◎', desc: 'Switch the model for this session' },
  { id: 'resume', trigger: '/resume', kind: 'local', glyph: '⟲', desc: 'Reopen a past session in a new tab' },
  { id: 'compact', trigger: '/compact', kind: 'agent', glyph: '⊘', desc: 'Summarize context to free tokens' },
  { id: 'init', trigger: '/init', kind: 'agent', glyph: '✦', desc: 'Generate a CLAUDE.md for this repo' },
  { id: 'review', trigger: '/review', kind: 'agent', args: '[target]', glyph: '▤', desc: 'Review the current diff' },
  { id: 'commit', trigger: '/commit', kind: 'agent', args: '[msg]', glyph: '✎', desc: 'Stage and commit changes' },
];

const byId = new Map(AGENT_COMMANDS.map((c) => [c.id, c]));

/** Palette is active only while the draft is a single `/word` with no space. */
export function matchCommands(draft: string): AgentCommand[] {
  if (!draft.startsWith('/') || draft.includes(' ')) return [];
  const q = draft.slice(1).toLowerCase();
  if (q === '') return AGENT_COMMANDS;
  return AGENT_COMMANDS.filter((c) => c.id.includes(q));
}

export function dispatchDraft(draft: string): DispatchResult {
  if (!draft.startsWith('/')) return { type: 'none' };
  const [head, ...rest] = draft.slice(1).split(' ');
  const cmd = byId.get(head);
  if (cmd?.kind === 'local') return { type: 'local', id: cmd.id, args: rest.join(' ') };
  return { type: 'agentText', text: draft };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/desktop run test agentCommands`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/agent/agentCommands.ts apps/desktop/src/agent/agentCommands.test.ts
git commit -m "feat(desktop): agent chat slash-command table + matcher"
```

---

### Task 2: Palette state in desktop AgentChatModel

**Files:**
- Modify: `apps/desktop/src/agent/agentChatModel.ts`
- Test: `apps/desktop/src/agent/agentChatModel.test.ts`

**Interfaces:**
- Consumes: `matchCommands` (Task 1).
- Produces: `AgentSnapshot` gains `paletteIndex: number` and `pendingPicker: 'model' | 'resume' | null`. New methods: `movePalette(delta: number): void`, `openPicker(kind: 'model' | 'resume'): void`, `closePicker(): void`, `clearTranscript(): void`. `setDraft` clamps `paletteIndex` to the current match count.

- [ ] **Step 1: Write the failing test**

```ts
// append to apps/desktop/src/agent/agentChatModel.test.ts
import { matchCommands } from './agentCommands';

test('setDraft resets palette index; movePalette wraps within matches', () => {
  const m = new AgentChatModel();
  m.setDraft('/c'); // matches clear, copy, compact, commit
  const n = matchCommands('/c').length;
  expect(m.snapshot().paletteIndex).toBe(0);
  m.movePalette(-1);
  expect(m.snapshot().paletteIndex).toBe(n - 1); // wraps to last
  m.movePalette(1);
  expect(m.snapshot().paletteIndex).toBe(0);
});

test('openPicker/closePicker toggle pendingPicker', () => {
  const m = new AgentChatModel();
  m.openPicker('model');
  expect(m.snapshot().pendingPicker).toBe('model');
  m.closePicker();
  expect(m.snapshot().pendingPicker).toBeNull();
});

test('clearTranscript empties messages', () => {
  const m = new AgentChatModel();
  m.apply({ t: 'agent.user', seq: 1, text: 'hi' });
  expect(m.snapshot().messages.length).toBe(1);
  m.clearTranscript();
  expect(m.snapshot().messages.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --cwd apps/desktop run test agentChatModel`
Expected: FAIL — `paletteIndex`/`pendingPicker`/methods undefined.

- [ ] **Step 3: Write minimal implementation**

In `agentChatModel.ts`: add private fields and extend the snapshot.

```ts
// with the other private fields (near line 64)
private paletteIndex = 0;
private pendingPicker: 'model' | 'resume' | null = null;

// inside snapshot() object literal (add two fields)
paletteIndex: this.paletteIndex,
pendingPicker: this.pendingPicker,

// setDraft (replace body near line 267)
setDraft(text: string): void {
  this.draft = text;
  const count = matchCommands(text).length;
  this.paletteIndex = count === 0 ? 0 : Math.min(this.paletteIndex, count - 1);
  this.changed();
}

// new methods
movePalette(delta: number): void {
  const count = matchCommands(this.draft).length;
  if (count === 0) return;
  this.paletteIndex = (this.paletteIndex + delta + count) % count;
  this.changed();
}
openPicker(kind: 'model' | 'resume'): void {
  this.pendingPicker = kind;
  this.changed();
}
closePicker(): void {
  this.pendingPicker = null;
  this.changed();
}
clearTranscript(): void {
  this.messages = [];
  this.changed();
}
```

Add to the `AgentSnapshot` interface: `paletteIndex: number;` and `pendingPicker: 'model' | 'resume' | null;`. Import `matchCommands` from `./agentCommands` at the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --cwd apps/desktop run test agentChatModel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/agent/agentChatModel.ts apps/desktop/src/agent/agentChatModel.test.ts
git commit -m "feat(desktop): palette + picker state in AgentChatModel"
```

---

### Task 3: Desktop composer palette UI

**Files:**
- Modify: `apps/desktop/src/agent/AgentComposer.tsx`
- Modify: `apps/desktop/src/index.css`

**Interfaces:**
- Consumes: `matchCommands`, `dispatchDraft` (Task 1); `movePalette`, `openPicker`, `clearTranscript`, `setDraft`, `notePromptSent`, `enqueue` (Task 2 + existing).
- Produces: no exported symbols; behavior only.

**Behavior:** When `matchCommands(draft)` is non-empty, render a `.agent-palette` popover above the input. ↑/↓ call `movePalette(∓1)`; Tab completes the highlighted trigger into the draft; Enter runs the highlighted command; Esc clears the draft's palette by appending a space is wrong — Esc sets draft to `''`. When the palette is closed, Enter keeps the existing submit path, except a draft that `dispatchDraft` classifies as `local`/`agentText` routes accordingly.

- [ ] **Step 1: Add a dispatch helper and palette render to `AgentComposer.tsx`**

Replace `submit` and `onKeyDown`, and add palette rendering. The runnable check is the model test above plus a manual smoke; this component has no unit test harness, so the deliverable is verified by `bun --cwd apps/desktop run test` (regression) + typecheck.

```tsx
import { AGENT_COMMANDS, dispatchDraft, matchCommands } from './agentCommands';
// ...
const matches = matchCommands(draft);
const paletteOpen = matches.length > 0;
const highlighted = matches[Math.min(snapshot.paletteIndex, matches.length - 1)];

const runLocal = (id: string, args: string) => {
  model.setDraft('');
  if (id === 'clear') model.clearTranscript();
  else if (id === 'retry') { const t = model.retryLast(); if (t) send(agentPrompt(t)); }
  else if (id === 'copy') void navigator.clipboard.writeText(transcriptText(snapshot, args));
  else if (id === 'model') model.openPicker('model');
  else if (id === 'resume') { model.openPicker('resume'); send(agentListSessions(cwd)); }
};

const runDraft = () => {
  const r = dispatchDraft(draft);
  if (r.type === 'local') return runLocal(r.id, r.args);
  if (r.type === 'agentText') {
    if (streaming) model.enqueue(r.text);
    else { model.notePromptSent(); send(agentPrompt(r.text)); }
    return model.setDraft('');
  }
  submit(); // 'none' → normal prompt path
};

const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (paletteOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); return model.movePalette(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); return model.movePalette(-1); }
    if (e.key === 'Tab') { e.preventDefault(); return model.setDraft(highlighted.trigger); }
    if (e.key === 'Escape') { e.preventDefault(); return model.setDraft(''); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return runLocalOrForward(highlighted); }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runDraft(); }
};

const runLocalOrForward = (cmd: typeof AGENT_COMMANDS[number]) => {
  if (cmd.kind === 'local') return runLocal(cmd.id, '');
  if (streaming) model.enqueue(cmd.trigger);
  else { model.notePromptSent(); send(agentPrompt(cmd.trigger)); }
  model.setDraft('');
};
```

Add `cwd` to `AgentComposer` props (thread from `AgentChatPane`), import `agentListSessions` (Task 6). Add a `transcriptText(snapshot, mode)` helper in a new `apps/desktop/src/agent/transcriptText.ts` (pure) — `mode==='last'` returns the last assistant message's plainText, else the whole transcript joined.

- [ ] **Step 2: Render the palette popover**

Above `.agent-composer-input`, before `AgentInfoStrip`:

```tsx
{paletteOpen && (
  <div className="agent-palette">
    {matches.map((c, i) => (
      <button
        type="button"
        key={c.id}
        className={`agent-palette-row${i === snapshot.paletteIndex ? ' sel' : ''}`}
        onMouseDown={(e) => { e.preventDefault(); runLocalOrForward(c); }}
      >
        <span className="agent-palette-glyph">{c.glyph}</span>
        <span className="agent-palette-name">{c.trigger}</span>
        {c.args && <span className="agent-palette-args">{c.args}</span>}
        <span className="agent-palette-desc">{c.desc}</span>
        {c.kind === 'agent' && <span className="agent-palette-tag">agent</span>}
      </button>
    ))}
  </div>
)}
```

- [ ] **Step 3: Add CSS** (append near the other `.agent-*` rules, ~index.css:3130). Match the mock: `--raised` bg, accent-tinted selected row, mono trigger.

```css
.agent-palette { display: flex; flex-direction: column; margin-bottom: 8px; border: 1px solid var(--border); border-radius: var(--r-panel); background: var(--surface-raised); overflow: hidden; }
.agent-palette-row { display: grid; grid-template-columns: 20px auto 1fr auto; gap: 10px; align-items: baseline; padding: 7px 10px; background: none; border: none; cursor: pointer; text-align: left; color: var(--text); }
.agent-palette-row.sel { background: color-mix(in srgb, var(--accent) 15%, var(--surface-raised)); }
.agent-palette-glyph { color: var(--text-faint); }
.agent-palette-name { font-family: var(--mono); font-size: 13px; color: var(--accent); white-space: nowrap; }
.agent-palette-args { font-family: var(--mono); font-size: 12px; color: var(--text-faint); }
.agent-palette-desc { font-size: 12px; color: var(--text-muted); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-palette-tag { font-size: 10px; color: var(--text-faint); border: 1px solid var(--border); border-radius: 999px; padding: 1px 6px; }
```

- [ ] **Step 4: Verify regressions + types**

Run: `bun --cwd apps/desktop run test` then `bun lint`
Expected: PASS; no type errors (add `cwd?: string` to composer props + thread it).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/agent/AgentComposer.tsx apps/desktop/src/agent/transcriptText.ts apps/desktop/src/index.css apps/desktop/src/agent/AgentChatPane.tsx
git commit -m "feat(desktop): slash-command palette in agent composer"
```

---

### Task 4: iOS command module + palette state

**Files:**
- Create: `clients/apple/TetherKit/Sources/TetherKit/Agent/AgentCommands.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Agent/AgentChatModel.swift`
- Test: `clients/apple/TetherKit/Tests/TetherKitTests/AgentCommandsTests.swift`

**Interfaces:**
- Produces: `AgentCommand` struct + `agentCommands` array + `matchCommands(_ draft:) -> [AgentCommand]` + `dispatchDraft(_ draft:) -> AgentDispatch`. On the model: `pendingPicker: AgentPickerKind?` (`.model`/`.resume`), `paletteIndex: Int`, `clearTranscript()`, `openPicker(_:)`, `closePicker()`.

- [ ] **Step 1: Write the failing test**

```swift
// clients/apple/TetherKit/Tests/TetherKitTests/AgentCommandsTests.swift
import XCTest
@testable import TetherKit

final class AgentCommandsTests: XCTestCase {
  func testBareSlashReturnsAll() {
    XCTAssertEqual(matchCommands("/").count, agentCommands.count)
  }
  func testFiltersBySubstring() {
    let ids = matchCommands("/co").map(\.id)
    XCTAssertTrue(ids.contains("copy"))
    XCTAssertTrue(ids.contains("compact"))
    XCTAssertFalse(ids.contains("clear"))
  }
  func testSpaceClosesPalette() {
    XCTAssertTrue(matchCommands("/model sonnet").isEmpty)
  }
  func testDispatchLocalAgentPassthrough() {
    XCTAssertEqual(dispatchDraft("/copy all"), .local(id: "copy", args: "all"))
    XCTAssertEqual(dispatchDraft("/compact"), .agentText("/compact"))
    XCTAssertEqual(dispatchDraft("/wibble x"), .agentText("/wibble x"))
    XCTAssertEqual(dispatchDraft("hello"), .none)
  }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `xcodebuild test -project clients/apple/Tether.xcodeproj -scheme TetherIOS -destination 'platform=iOS Simulator,name=iPhone 15' -only-testing:TetherKitTests/AgentCommandsTests` (on macbuild host)
Expected: FAIL — `matchCommands` undefined.

- [ ] **Step 3: Write minimal implementation**

```swift
// clients/apple/TetherKit/Sources/TetherKit/Agent/AgentCommands.swift
import Foundation

public struct AgentCommand: Equatable, Identifiable, Sendable {
  public let id: String
  public let trigger: String
  public let kind: Kind
  public let args: String?
  public let glyph: String
  public let desc: String
  public enum Kind: Sendable { case local, agent }
}

public enum AgentDispatch: Equatable, Sendable {
  case local(id: String, args: String)
  case agentText(String)
  case none
}

public enum AgentPickerKind: Sendable { case model, resume }

public let agentCommands: [AgentCommand] = [
  .init(id: "clear", trigger: "/clear", kind: .local, args: nil, glyph: "⌫", desc: "Start a fresh conversation"),
  .init(id: "copy", trigger: "/copy", kind: .local, args: "[last|all]", glyph: "⧉", desc: "Copy the transcript"),
  .init(id: "retry", trigger: "/retry", kind: .local, args: nil, glyph: "↻", desc: "Resend the last prompt"),
  .init(id: "model", trigger: "/model", kind: .local, args: nil, glyph: "◎", desc: "Switch the model"),
  .init(id: "resume", trigger: "/resume", kind: .local, args: nil, glyph: "⟲", desc: "Reopen a past session"),
  .init(id: "compact", trigger: "/compact", kind: .agent, args: nil, glyph: "⊘", desc: "Summarize context"),
  .init(id: "init", trigger: "/init", kind: .agent, args: nil, glyph: "✦", desc: "Generate a CLAUDE.md"),
  .init(id: "review", trigger: "/review", kind: .agent, args: "[target]", glyph: "▤", desc: "Review the current diff"),
  .init(id: "commit", trigger: "/commit", kind: .agent, args: "[msg]", glyph: "✎", desc: "Stage and commit"),
]

public func matchCommands(_ draft: String) -> [AgentCommand] {
  guard draft.hasPrefix("/"), !draft.contains(" ") else { return [] }
  let q = draft.dropFirst().lowercased()
  if q.isEmpty { return agentCommands }
  return agentCommands.filter { $0.id.contains(q) }
}

public func dispatchDraft(_ draft: String) -> AgentDispatch {
  guard draft.hasPrefix("/") else { return .none }
  let parts = draft.dropFirst().split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
  let head = String(parts.first ?? "")
  let args = parts.count > 1 ? String(parts[1]) : ""
  if let cmd = agentCommands.first(where: { $0.id == head }), cmd.kind == .local {
    return .local(id: cmd.id, args: args)
  }
  return .agentText(draft)
}
```

Add to `AgentChatModel`: `public var pendingPicker: AgentPickerKind?` and `public var paletteIndex = 0`, plus:
```swift
public func clearTranscript() { messages = []; revision += 1 }
public func openPicker(_ kind: AgentPickerKind) { pendingPicker = kind; revision += 1 }
public func closePicker() { pendingPicker = nil; revision += 1 }
```

- [ ] **Step 4: Run to verify it passes**

Run: same `xcodebuild test -only-testing:TetherKitTests/AgentCommandsTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Agent/AgentCommands.swift clients/apple/TetherKit/Sources/TetherKit/Agent/AgentChatModel.swift clients/apple/TetherKit/Tests/TetherKitTests/AgentCommandsTests.swift
git commit -m "feat(ios): agent chat slash-command table + palette state"
```

---

### Task 5: iOS composer palette UI

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Views/AgentChatView.swift`

**Interfaces:**
- Consumes: `matchCommands`, `dispatchDraft`, `agentCommands` (Task 4); model `clearTranscript`/`openPicker`/`submit`/`retryLast`/`interrupt`.
- Produces: behavior only.

**Behavior:** iOS is touch-first — render matches as a tappable list ABOVE the TextField (no ↑↓/Tab). Tapping a `local` row runs it; an `agent`/passthrough row (and the send button when the draft is a command) forwards verbatim.

- [ ] **Step 1: Add palette list to `AgentComposerView.body`**

Above `AgentInfoStrip` (L262):

```swift
if !matchCommands(model.draft).isEmpty {
  VStack(spacing: 0) {
    ForEach(matchCommands(model.draft)) { cmd in
      Button { runCommand(cmd) } label: {
        HStack(spacing: 10) {
          Text(cmd.glyph).foregroundStyle(TetherColors.textFaint)
          Text(cmd.trigger).font(.system(.callout, design: .monospaced)).foregroundStyle(TetherColors.accent)
          if let a = cmd.args { Text(a).font(.system(.caption, design: .monospaced)).foregroundStyle(TetherColors.textFaint) }
          Spacer()
          Text(cmd.desc).font(.caption).foregroundStyle(TetherColors.textSecondary).lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
      }
      .buttonStyle(.plain)
    }
  }
  .background(TetherColors.surfaceRaised)
  .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
  .overlay(RoundedRectangle(cornerRadius: 10).stroke(TetherColors.border, lineWidth: 1))
  .padding(.bottom, 8)
}
```

- [ ] **Step 2: Add the `runCommand` + `sendOrStop` dispatch**

```swift
private func runCommand(_ cmd: AgentCommand) {
  model.draft = ""
  switch cmd.kind {
  case .local:
    switch cmd.id {
    case "clear": model.clearTranscript()
    case "retry": model.retryLast()
    case "model": model.openPicker(.model)
    case "resume": model.openPicker(.resume); model.requestSessions()
    default: break
    }
  case .agent:
    model.submit(cmd.trigger)
  }
}
```

Update `sendOrStop()` (L315): when `!isStop`, dispatch the draft — `dispatchDraft(model.draft)` → `.local` runs it, `.agentText` submits, `.none` submits normally. (`model.requestSessions()` is added in Task 8; stub it as an empty method for now so this compiles, wired in Phase 3.)

- [ ] **Step 3: Run the existing model tests (regression) + build**

Run: `xcodebuild test -project clients/apple/Tether.xcodeproj -scheme TetherIOS -destination 'platform=iOS Simulator,name=iPhone 15' -only-testing:TetherKitTests` (on macbuild)
Expected: PASS (build succeeds, existing agent tests green).

- [ ] **Step 4: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Views/AgentChatView.swift clients/apple/TetherKit/Sources/TetherKit/Agent/AgentChatModel.swift
git commit -m "feat(ios): slash-command palette in agent composer"
```

---

## PHASE 2 — /model

### Task 6: Server — driver model flag + resume seed (pure arg builder)

**Files:**
- Modify: `apps/server/src/server/agentClaudeDriver.ts`
- Modify: `apps/server/src/server/agentDriver.ts`
- Test: `apps/server/src/server/agentClaudeDriver.test.ts`

**Interfaces:**
- Produces: exported pure `buildClaudeArgs(opts: { text: string; sessionId: string | null; model: string | null }): string[]`. `AgentDriver` interface gains `setModel?(name: string | null): void` and `seedResume?(sessionId: string): void`. `AgentClaudeDriver` implements both.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/server/agentClaudeDriver.test.ts (add)
import { buildClaudeArgs } from './agentClaudeDriver';

test('buildClaudeArgs: base flags, no model, no resume', () => {
  const a = buildClaudeArgs({ text: 'hi', sessionId: null, model: null });
  expect(a[0]).toBe('claude');
  expect(a).toContain('--print');
  expect(a).not.toContain('--model');
  expect(a).not.toContain('--resume');
  expect(a.slice(-2)).toEqual(['--', 'hi']);
});
test('buildClaudeArgs: includes --model and --resume when set', () => {
  const a = buildClaudeArgs({ text: 'go', sessionId: 'sid-1', model: 'sonnet' });
  expect(a).toContain('--model'); expect(a[a.indexOf('--model') + 1]).toBe('sonnet');
  expect(a).toContain('--resume'); expect(a[a.indexOf('--resume') + 1]).toBe('sid-1');
  expect(a.slice(-2)).toEqual(['--', 'go']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/server run test agentClaudeDriver`
Expected: FAIL — `buildClaudeArgs` not exported.

- [ ] **Step 3: Extract the pure builder and use it**

```ts
// agentClaudeDriver.ts — new export near the top
export function buildClaudeArgs(opts: {
  text: string;
  sessionId: string | null;
  model: string | null;
}): string[] {
  const args = [
    'claude', '--print', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--dangerously-skip-permissions',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  args.push('--', opts.text);
  return args;
}
```

In the class: add `setModel(name: string | null) { this.currentModel = name; }` and `seedResume(sessionId: string) { this.sessionId = sessionId; }`. In `prompt()` replace the inline `args` array with `const args = buildClaudeArgs({ text, sessionId: this.sessionId, model: this.currentModel });`. Add `setModel?`/`seedResume?` to the `AgentDriver` interface in `agentDriver.ts`.

> Note: `getModel()` still returns `currentModel`. Because a user-set model now writes `currentModel`, `captureInit` must NOT overwrite a user override — guard: only set `currentModel` from init if it is currently `null`. Update `captureInit`:
```ts
const model = extractModel(line);
if (model && this.currentModel === null) this.currentModel = model;
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/server run test agentClaudeDriver`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/agentClaudeDriver.ts apps/server/src/server/agentDriver.ts apps/server/src/server/agentClaudeDriver.test.ts
git commit -m "feat(server): claude arg builder with --model/--resume + driver setModel/seedResume"
```

---

### Task 7: Server — registry setModel + start options; DB + config

**Files:**
- Modify: `apps/server/src/server/agentRegistry.ts`
- Modify: `apps/server/src/server/db.ts`
- Modify: `apps/server/src/server/config.ts`
- Test: `apps/server/src/server/agentRegistry.test.ts`, `apps/server/src/server/config.test.ts`

**Interfaces:**
- Produces: `AgentRegistry.setModel(id: string, name: string | null): void`; `AgentRegistry.start(id, cwd, opts?: { model?: string | null; resumeSessionId?: string }): Promise<void>`. `db.ts`: migration v13 adds `sessions.model TEXT`; `setSessionModel(db, id, model)`. `config.ts`: `agent: { defaultModel: string }` (default `''`).

- [ ] **Step 1: Write the failing tests**

```ts
// agentRegistry.test.ts (add) — extend the fake to capture setModel/seed
test('registry.setModel routes to the driver; start passes model + resume', async () => {
  const calls: string[] = [];
  class Spy extends FakeAgentDriver {
    setModel(n: string | null) { calls.push(`model:${n}`); }
    seedResume(s: string) { calls.push(`resume:${s}`); }
  }
  const reg = new AgentRegistry(() => new Spy([]));
  await reg.start('a', '/tmp', { model: 'opus', resumeSessionId: 'sid' });
  reg.setModel('a', 'haiku');
  expect(calls).toEqual(['model:opus', 'resume:sid', 'model:haiku']);
});
```

```ts
// config.test.ts (add)
test('agent.defaultModel defaults to empty and round-trips through patch', () => {
  expect(getConfig().agent.defaultModel).toBe('');
  patchConfig({ agent: { defaultModel: 'sonnet' } });
  expect(getConfig().agent.defaultModel).toBe('sonnet');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun --cwd apps/server run test agentRegistry` and `... run test config`
Expected: FAIL.

- [ ] **Step 3: Implement**

`agentRegistry.ts` — extend `start` and add `setModel`:
```ts
async start(id: string, cwd: string, opts?: { model?: string | null; resumeSessionId?: string }): Promise<void> {
  if (this.entries.has(id) || this.starting.has(id)) return;
  this.starting.add(id);
  try {
    const driver = this.driverFactory();
    await driver.start(cwd);
    if (opts?.model != null) driver.setModel?.(opts.model);
    if (opts?.resumeSessionId) driver.seedResume?.(opts.resumeSessionId);
    const seq = new FrameSeq(this.seqSeed(id));
    this.entries.set(id, { driver, seq, sinks: new Set(), deltaBuf: null });
  } finally { this.starting.delete(id); }
}

setModel(id: string, name: string | null): void {
  this.entries.get(id)?.driver.setModel?.(name);
}
```

`db.ts` — add migration entry (append after v12):
```ts
{
  version: 13,
  name: 'session_model',
  up: `ALTER TABLE sessions ADD COLUMN model TEXT;`,
},
```
Add `model: string | null;` to the `Session` type and a writer:
```ts
export function setSessionModel(db: Database, id: string, model: string | null): void {
  db.query(`UPDATE sessions SET model = $model WHERE id = $id`).run({ $id: id, $model: model });
}
```

`config.ts` — add to `configSchema`: `agent: z.object({ defaultModel: z.string().max(200) })`; to `DEFAULT_CONFIG`: `agent: { defaultModel: '' }`; add read entry in `getConfig` (`agent: readTopLevel('agent')`) and a partial branch in `patchConfig` mirroring the other sections.

- [ ] **Step 4: Run to verify they pass**

Run: `bun --cwd apps/server run test agentRegistry` and `... run test config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/agentRegistry.ts apps/server/src/server/db.ts apps/server/src/server/config.ts apps/server/src/server/agentRegistry.test.ts apps/server/src/server/config.test.ts
git commit -m "feat(server): registry setModel + start opts, sessions.model migration, agent.defaultModel setting"
```

---

### Task 8: Server — agent.model handler + wire frames; default-model seeding

**Files:**
- Modify: `apps/server/src/server/noiseSessionProtocol.ts`
- Modify: `apps/server/src/server/agentReplay.ts`
- Test: `apps/server/src/server/noiseSessionProtocol.test.ts`

**Interfaces:**
- Consumes: `registry.setModel`, `setSessionModel`, `patchConfig`/`getConfig`, `sendAgentStatus` (existing).
- Produces: `ClientMessage` gains `{ t: 'agent.model'; name: string }`. `applyAgentStart` reads `settings.agent.defaultModel` and passes it to `registry.start({ model })`.

- [ ] **Step 1: Write the failing test**

```ts
// noiseSessionProtocol.test.ts (add) — using the existing fake harness
test('agent.model sets the driver model, persists default, re-emits status', async () => {
  // arrange a session via agent.start with a FakeAgentDriver exposing setModel/getModel
  // (mirror the existing agent.start test setup in this file)
  // act: applyMessage({ t: 'agent.model', name: 'opus' }, ...)
  // assert: sent frames include an 'agent.status' with model 'opus';
  //         getConfig().agent.defaultModel === 'opus'
});
```
(Fill the arrange/act using the file's existing `agent.start` test scaffold — same `SessionDeps` fake, `sendSealed` capture array, and `AgentState`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/server run test noiseSessionProtocol`
Expected: FAIL — no `agent.model` branch.

- [ ] **Step 3: Implement**

In `noiseSessionProtocol.ts`: add to the `ClientMessage` union `| { t: 'agent.model'; name: string }` and `| { t: 'agent.list-sessions'; cwd: string }` (the latter handled in Task 10). Add a branch in `applyMessage`:
```ts
} else if (msg.t === 'agent.model') {
  if (agent.currentId) {
    agent.registry.setModel(agent.currentId, msg.name || null);
    setSessionModel(db, agent.currentId, msg.name || null);
    patchConfig({ agent: { defaultModel: msg.name } });
    void sendAgentStatus(agent.currentId, d, sendSealed, agent);
  }
}
```

In `agentReplay.ts` `applyAgentStart`, when starting a fresh driver, seed the model:
```ts
const persistedModel = getSession(msg.id)?.model ?? null;
const defaultModel = getConfig().agent.defaultModel || null;
await agent.registry.start(msg.id, cwd, {
  model: persistedModel ?? defaultModel,
  resumeSessionId: msg.resumeClaudeSessionId, // Task 9 adds this field
});
```
(Extend the `msg` param type to include `resumeClaudeSessionId?: string` now to avoid a second edit.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/server run test noiseSessionProtocol`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/noiseSessionProtocol.ts apps/server/src/server/agentReplay.ts apps/server/src/server/noiseSessionProtocol.test.ts
git commit -m "feat(server): agent.model handler, per-session + default model seeding"
```

---

### Task 9: Desktop + iOS — /model picker

**Files:**
- Desktop: create `apps/desktop/src/agent/AgentModelPicker.tsx`; modify `agentFrames.ts`, `AgentChatPane.tsx`, `index.css`.
- iOS: create model-picker sheet in `AgentChatView.swift`; modify `AgentChatModel.swift` (`AgentOutbound.model`), `SessionStore.swift`, `TerminalPipeline.swift`, `NoiseSessionClient.swift`.
- Test: `apps/desktop/src/agent/agentFrames.test.ts`; iOS model test.

**Interfaces:**
- Produces (desktop): `agentModel(name: string) => { t: 'agent.model', name }`. Picker renders when `snapshot.pendingPicker === 'model'`.
- Produces (iOS): `AgentOutbound.model(String)` → `routeAgentOutbound` yields `.agentModel(name)` → `NoiseSessionClient.agentModelRequest(name)` → `{t:'agent.model',name}`.

- [ ] **Step 1: Desktop failing test**

```ts
// agentFrames.test.ts (add)
import { agentModel } from './agentFrames';
test('agentModel builds the model frame', () => {
  expect(agentModel('opus')).toEqual({ t: 'agent.model', name: 'opus' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/desktop run test agentFrames`
Expected: FAIL.

- [ ] **Step 3: Implement desktop**

`agentFrames.ts`: `export function agentModel(name: string) { return { t: 'agent.model' as const, name }; }`. Add `MODEL_ALIASES` to `agentCommands.ts`:
```ts
export const MODEL_ALIASES = [
  { name: 'sonnet', desc: 'Balanced — the default for coding turns' },
  { name: 'opus', desc: 'Deepest reasoning, slower' },
  { name: 'haiku', desc: 'Fast and cheap for light edits' },
  { name: 'opusplan', desc: 'Opus to plan, Sonnet to execute' },
  { name: 'default', desc: 'Whatever your subscription picks' },
];
```
Create `AgentModelPicker.tsx`: a `.agent-folder-backdrop`-style overlay listing `MODEL_ALIASES` (current one — `snapshot.status?.model` — checked) plus a "type a model ID" text input; `onPick(name)` calls `send(agentModel(name))` then `model.closePicker()`. Mount it in `AgentChatPane.tsx` when `snapshot.pendingPicker === 'model'`, reusing the folder-picker CSS classes.

- [ ] **Step 4: Implement iOS**

Add `.model(String)` to `AgentOutbound`. In `routeAgentOutbound` add `case let .model(name): pipeline.outbound.yield(.agentModel(name))`. Add `agentModel(String)` to `OutboundFrame`, drain it to `channel.sendAgentModel(name)`, add `NoiseSessionClient.agentModelRequest(name:) -> ["t":"agent.model","name":name]`. In `AgentChatModel` add `public func setModel(_ name: String) { send(.model(name)) }`. Add a `.sheet` on `AgentChatView.body` bound to `model.pendingPicker == .model` presenting a `List` of `MODEL_ALIASES` (mirror `AgentApprovalSheet`), each row calling `model.setModel(name); model.closePicker()`, plus a TextField row for a custom ID.

- [ ] **Step 5: Verify + commit**

Run: `bun --cwd apps/desktop run test agentFrames`, `bun lint`, iOS `xcodebuild test -only-testing:TetherKitTests`.
Expected: PASS.

```bash
git add apps/desktop/src/agent/AgentModelPicker.tsx apps/desktop/src/agent/agentFrames.ts apps/desktop/src/agent/agentCommands.ts apps/desktop/src/agent/AgentChatPane.tsx apps/desktop/src/index.css apps/desktop/src/agent/agentFrames.test.ts clients/apple/TetherKit/Sources/TetherKit/Agent/AgentChatModel.swift clients/apple/TetherKit/Sources/TetherKit/Views/AgentChatView.swift clients/apple/TetherKit/Sources/TetherKit/SessionStore.swift clients/apple/TetherKit/Sources/TetherKit/Terminal/TerminalPipeline.swift clients/apple/TetherKit/Sources/TetherKit/Noise/NoiseSessionClient.swift
git commit -m "feat: /model picker (desktop + ios)"
```

---

## PHASE 3 — /resume

### Task 10: Server — claudeSessions: slug + list

**Files:**
- Create: `apps/server/src/server/claudeSessions.ts`
- Test: `apps/server/src/server/claudeSessions.test.ts`

**Interfaces:**
- Produces: `slugForCwd(cwd: string): string`; `ClaudeSessionMeta = { id: string; label: string; mtimeMs: number; msgCount: number; cwd: string }`; `listClaudeSessions(cwd: string, opts?: { projectsDir?: string; cap?: number }): ClaudeSessionMeta[]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/server/claudeSessions.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listClaudeSessions, slugForCwd } from './claudeSessions';

test('slugForCwd maps slashes to dashes', () => {
  expect(slugForCwd('/home/sam/sites/tether')).toBe('-home-sam-sites-tether');
});

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cs-'));
  const proj = join(root, slugForCwd('/work/repo'));
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, '11111111-aaaa-bbbb-cccc-000000000001.jsonl'),
    [JSON.stringify({ type: 'last-prompt', leafUuid: 'u1' }),
     JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the socket' }, uuid: 'u1' })].join('\n'));
});
test('listClaudeSessions returns meta with a label', () => {
  const out = listClaudeSessions('/work/repo', { projectsDir: root });
  expect(out.length).toBe(1);
  expect(out[0].id).toBe('11111111-aaaa-bbbb-cccc-000000000001');
  expect(out[0].label).toContain('fix the socket');
  expect(out[0].msgCount).toBeGreaterThan(0);
});
test('missing project dir → empty list, no throw', () => {
  expect(listClaudeSessions('/nope', { projectsDir: root })).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/server run test claudeSessions`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/server/claudeSessions.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeSessionMeta {
  id: string; label: string; mtimeMs: number; msgCount: number; cwd: string;
}

export function slugForCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Best-effort last user message text from a session jsonl. */
function labelFor(path: string): { label: string; msgCount: number } {
  let label = '';
  let msgCount = 0;
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { continue; }
      const message = obj.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === 'user') {
        msgCount += 1;
        const content = message.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content.find((b) => (b as { type?: string }).type === 'text') as { text?: string } | undefined)?.text ?? ''
            : '';
        if (text) label = text;
      }
    }
  } catch { /* unreadable → empty */ }
  return { label: label.slice(0, 120), msgCount };
}

export function listClaudeSessions(
  cwd: string,
  opts?: { projectsDir?: string; cap?: number },
): ClaudeSessionMeta[] {
  const dir = join(opts?.projectsDir ?? defaultProjectsDir(), slugForCwd(cwd));
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
  const out: ClaudeSessionMeta[] = names.map((n) => {
    const path = join(dir, n);
    const { label, msgCount } = labelFor(path);
    return { id: n.replace(/\.jsonl$/, ''), label, msgCount, cwd, mtimeMs: statSync(path).mtimeMs };
  });
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, opts?.cap ?? 50);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/server run test claudeSessions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/claudeSessions.ts apps/server/src/server/claudeSessions.test.ts
git commit -m "feat(server): list Claude Code sessions from ~/.claude/projects"
```

---

### Task 11: Server — translateSessionJsonl

**Files:**
- Modify: `apps/server/src/server/claudeSessions.ts`
- Test: `apps/server/src/server/claudeSessions.test.ts`

**Interfaces:**
- Produces: `TranslatedMessage = { kind: AgentMessageRow['kind']; text?: string; toolJson?: string; isError?: boolean }`; `translateSessionJsonl(path: string, opts?: { maxTurns?: number }): TranslatedMessage[]`. Caller assigns seqs and calls `appendAgentMessage`.

- [ ] **Step 1: Write the failing test**

```ts
// claudeSessions.test.ts (add)
import { translateSessionJsonl } from './claudeSessions';
import { writeFileSync } from 'node:fs';

test('translateSessionJsonl maps user/assistant/tool events in order', () => {
  const p = join(root, 'sample.jsonl');
  writeFileSync(p, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'do it' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'working' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } },
    ] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', content: 'ok', is_error: false },
    ] } }),
  ].join('\n'));
  const rows = translateSessionJsonl(p);
  expect(rows.map((r) => r.kind)).toEqual(['user', 'delta', 'tool', 'tool_result']);
  expect(rows[0].text).toBe('do it');
  expect(JSON.parse(rows[2].toolJson!)).toMatchObject({ name: 'Edit' });
});

test('translateSessionJsonl tolerates unknown/corrupt lines', () => {
  const p = join(root, 'corrupt.jsonl');
  writeFileSync(p, 'not json\n' + JSON.stringify({ type: 'system' }) + '\n');
  expect(translateSessionJsonl(p)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/server run test claudeSessions`
Expected: FAIL — `translateSessionJsonl` undefined.

- [ ] **Step 3: Implement**

```ts
// claudeSessions.ts (add)
import type { AgentMessageRow } from './agentMessages';

export interface TranslatedMessage {
  kind: AgentMessageRow['kind'];
  text?: string;
  toolJson?: string;
  isError?: boolean;
}

export function translateSessionJsonl(path: string, opts?: { maxTurns?: number }): TranslatedMessage[] {
  let lines: string[];
  try { lines = readFileSync(path, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const rows: TranslatedMessage[] = [];
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.isSidechain === true) continue;
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    if (!message) continue;
    const content = message.content;
    if (message.role === 'user') {
      if (typeof content === 'string') { rows.push({ kind: 'user', text: content }); continue; }
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === 'tool_result') {
            const text = typeof b.content === 'string' ? b.content
              : Array.isArray(b.content) ? (b.content.find((x) => (x as { type?: string }).type === 'text') as { text?: string } | undefined)?.text ?? '' : '';
            rows.push({ kind: 'tool_result', text, isError: b.is_error === true });
          } else if (b.type === 'text' && typeof b.text === 'string') {
            rows.push({ kind: 'user', text: b.text });
          }
        }
      }
    } else if (message.role === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string') rows.push({ kind: 'delta', text: b.text });
        else if (b.type === 'tool_use') rows.push({ kind: 'tool', toolJson: JSON.stringify({ name: b.name ?? '', input: b.input ?? {} }) });
      }
    }
  }
  const maxTurns = opts?.maxTurns ?? 400;
  return rows.length > maxTurns ? rows.slice(rows.length - maxTurns) : rows;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/server run test claudeSessions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/claudeSessions.ts apps/server/src/server/claudeSessions.test.ts
git commit -m "feat(server): translate a Claude session jsonl into agent message rows"
```

---

### Task 12: Server — agent.list-sessions handler + resume in applyAgentStart

**Files:**
- Modify: `apps/server/src/server/noiseSessionProtocol.ts`
- Modify: `apps/server/src/server/agentReplay.ts`
- Test: `apps/server/src/server/noiseSessionProtocol.test.ts`

**Interfaces:**
- Consumes: `listClaudeSessions`, `translateSessionJsonl`, `appendAgentMessage`, `maxAgentSeq`, `getSession`.
- Produces: server → client frame `{ t: 'agent.sessions'; sessions: ClaudeSessionMeta[] }`. `agent.start` carries `resumeClaudeSessionId?`. When present on a brand-new session, `applyAgentStart` persists translated history (fresh seqs) before starting the driver.

- [ ] **Step 1: Write the failing test**

```ts
// noiseSessionProtocol.test.ts (add)
test('agent.list-sessions replies with agent.sessions', async () => {
  // arrange sendSealed capture; act applyMessage({ t: 'agent.list-sessions', cwd: '/work/repo' }, ...)
  // with a SessionDeps whose listClaudeSessions is stubbed to return one meta;
  // assert a frame { t: 'agent.sessions', sessions: [...] } was sent.
});
test('resume agent.start persists translated history before first prompt', async () => {
  // arrange a fresh session id + a resumeClaudeSessionId whose translate returns 2 rows (stub);
  // act applyAgentStart({ t:'agent.start', id, cwd, resumeClaudeSessionId }, ...);
  // assert getAgentMessages(id, 0) has 2 rows with seq 1,2 and the driver was started with resumeSessionId.
});
```
(Wire stubs by adding `listClaudeSessions`/`translateSessionJsonl` to `SessionDeps` so tests can inject fakes — see Step 3.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun --cwd apps/server run test noiseSessionProtocol`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `SessionDeps`: `listClaudeSessions: (cwd: string) => ClaudeSessionMeta[];` and `translateClaudeSession: (id: string, cwd: string) => TranslatedMessage[];` (defaults wire to the real module in `serve.ts`/wherever `SessionDeps` is constructed — grep for the existing `getAgentMessages:` default and add beside it).

`noiseSessionProtocol.ts` branch:
```ts
} else if (msg.t === 'agent.list-sessions') {
  sendSealed({ t: 'agent.sessions', sessions: d.listClaudeSessions(msg.cwd) });
}
```
Extend the `agent.start` message type with `resumeClaudeSessionId?: string`.

`agentReplay.ts` `applyAgentStart` — inside the `if (!agent.registry.has(msg.id))` block, BEFORE `createAgentSession`/`start`, persist translated history when resuming a fresh session:
```ts
createAgentSession(db, { id: msg.id, workspaceRoot: cwd });
if (msg.resumeClaudeSessionId) {
  const rows = d.translateClaudeSession(msg.resumeClaudeSessionId, cwd);
  let seq = 0;
  for (const r of rows) {
    appendAgentMessage(db, { sessionId: msg.id, seq: ++seq, kind: r.kind, text: r.text ?? null, toolJson: r.toolJson ?? null, isError: r.isError });
  }
}
const persistedModel = getSession(msg.id)?.model ?? null;
const defaultModel = getConfig().agent.defaultModel || null;
await agent.registry.start(msg.id, cwd, {
  model: persistedModel ?? defaultModel,
  resumeSessionId: msg.resumeClaudeSessionId,
});
```
(`registry.start` seeds `FrameSeq` from `maxAgentSeq`, so live frames continue after the persisted history's last seq — no collision.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun --cwd apps/server run test noiseSessionProtocol`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/noiseSessionProtocol.ts apps/server/src/server/agentReplay.ts apps/server/src/server/noiseSessionProtocol.test.ts
git commit -m "feat(server): agent.list-sessions + resume-into-new-tab history persistence"
```

---

### Task 13: Desktop /resume picker + new-tab threading

**Files:**
- Modify: `apps/desktop/src/agent/agentFrames.ts` (`agentListSessions`, `agent.sessions` in union, `resumeClaudeSessionId` on `agentStart`), `agentChatModel.ts` (store `resumeSessions` from `agent.sessions`), `agentBind.ts` (pass `resumeSessionId`), `useTetherDesktop.tsx` + `App.tsx` + `ResidentTerminals.tsx` (thread `resumeSessionId` into the agent view leaf).
- Create: `apps/desktop/src/agent/AgentResumePicker.tsx`.
- Test: `apps/desktop/src/agent/agentFrames.test.ts`, `agentChatModel.test.ts`.

**Interfaces:**
- Produces: `agentListSessions(cwd: string) => { t: 'agent.list-sessions', cwd }`; `agentStart` gains optional `resumeClaudeSessionId`. `AgentSnapshot` gains `resumeSessions: ClaudeSessionMeta[]` (client-side type mirror). Picking a session opens a new agent tab whose `agent.start` carries `resumeClaudeSessionId`.

- [ ] **Step 1: Failing tests**

```ts
// agentFrames.test.ts (add)
import { agentListSessions, agentStart } from './agentFrames';
test('agentListSessions + agentStart resume field', () => {
  expect(agentListSessions('/x')).toEqual({ t: 'agent.list-sessions', cwd: '/x' });
  expect(agentStart({ id: 'a', cwd: '/x', sinceSeq: 0, resumeClaudeSessionId: 'sid' }))
    .toMatchObject({ t: 'agent.start', resumeClaudeSessionId: 'sid' });
});
```
```ts
// agentChatModel.test.ts (add)
test('agent.sessions frame populates resumeSessions', () => {
  const m = new AgentChatModel();
  m.apply({ t: 'agent.sessions', sessions: [{ id: 's1', label: 'x', mtimeMs: 1, msgCount: 2, cwd: '/x' }] });
  expect(m.snapshot().resumeSessions.map((s) => s.id)).toEqual(['s1']);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun --cwd apps/desktop run test agentFrames agentChatModel`
Expected: FAIL.

- [ ] **Step 3: Implement**

`agentFrames.ts`: add builders + extend `agentStart(input: { id; cwd; sinceSeq; resumeClaudeSessionId?: string })` to spread the optional field; add `| { t: 'agent.sessions'; sessions: ClaudeSessionMeta[] }` to `AgentFrame`; define `ClaudeSessionMeta` client type. `agentChatModel.ts`: handle `agent.sessions` in `apply` (store into `resumeSessions`, add to snapshot, default `[]`). `agentBind.ts`: accept `resumeSessionId?` and include it in the `agentStart(...)` call. Thread a `resumeSessionId?: string` field on the agent view leaf: `useTetherDesktop.newAgentChat(hostId, resumeSessionId?)` → `App.startAgentChat(cwd, resumeSessionId?)` → `newSoloView({ hostId, sessionId, kind: 'agent', cwd, resumeSessionId })` → `ResidentTerminals` passes `resumeSessionId={session.resumeSessionId}` to `AgentChatPane` → `useAgentChat` → `bindAgentSession`. Create `AgentResumePicker.tsx` (folder-picker overlay style) listing `snapshot.resumeSessions` (label, relative time, msgCount, `⌂` when `s.cwd !== cwd`); `onPick(s)` calls the app's new-agent-chat entry with `resumeSessionId = s.id` and `model.closePicker()`.

- [ ] **Step 4: Run to verify they pass + lint**

Run: `bun --cwd apps/desktop run test`, `bun lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/agent/AgentResumePicker.tsx apps/desktop/src/agent/agentFrames.ts apps/desktop/src/agent/agentChatModel.ts apps/desktop/src/agent/agentBind.ts apps/desktop/src/useTetherDesktop.tsx apps/desktop/src/App.tsx apps/desktop/src/ResidentTerminals.tsx apps/desktop/src/agent/agentFrames.test.ts apps/desktop/src/agent/agentChatModel.test.ts apps/desktop/src/index.css
git commit -m "feat(desktop): /resume picker opens a past session in a new tab with history"
```

---

### Task 14: iOS /resume picker + new-tab threading

**Files:**
- Modify: `AgentChatModel.swift` (`AgentOutbound.listSessions(cwd:)`, `requestSessions()`, `resumeSessions` state, apply `agent.sessions`), `AgentChatView.swift` (resume sheet), `SessionStore.swift` (`newAgentChat(...,resumeSessionId:)`, route `.listSessions`), `TerminalPipeline.swift` + `NoiseSessionClient.swift` (frames), `NoiseServerMessage` decoding for `agent.sessions`.
- Test: extend `AgentChatModel` tests.

**Interfaces:**
- Produces: `AgentOutbound.listSessions(cwd: String)`; `newAgentChat(hostId:cwd:resumeSessionId:)` with `resumeSessionId: String? = nil` threaded into `.agentStart`; `ClaudeSessionMeta` Swift struct; `agent.sessions` decoded into `model.resumeSessions`.

- [ ] **Step 1: Failing test**

```swift
// extend an AgentChatModel test file
func testAgentSessionsPopulatesResumeList() {
  let m = AgentChatModel(sessionId: "a", cwd: "/x")
  m.apply(.agentSessions(sessions: [ClaudeSessionMeta(id: "s1", label: "x", mtimeMs: 1, msgCount: 2, cwd: "/x")]))
  XCTAssertEqual(m.resumeSessions.map(\.id), ["s1"])
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `xcodebuild test -only-testing:TetherKitTests` (macbuild)
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `ClaudeSessionMeta` struct (mirror server fields). Add `.listSessions(cwd:)` to `AgentOutbound`; `public func requestSessions() { send(.listSessions(cwd: cwd)) }`; `public private(set) var resumeSessions: [ClaudeSessionMeta] = []`. Decode `agent.sessions` into `NoiseServerMessage.agentSessions(sessions:)` and handle it in `apply` (set `resumeSessions`). Route `.listSessions` in `routeAgentOutbound` → `.agentListSessions(cwd)` OutboundFrame → `NoiseSessionClient.agentListSessionsRequest(cwd:) -> ["t":"agent.list-sessions","cwd":cwd]`. Extend `newAgentChat` with `resumeSessionId: String? = nil` and pass it into the `.agentStart(id:cwd:sinceSeq:resumeClaudeSessionId:)` frame (add the field to `OutboundFrame.agentStart` + `NoiseSessionClient.agentStartRequest`). Add a `.sheet` on `AgentChatView.body` for `model.pendingPicker == .resume` presenting a `List` of `model.resumeSessions` (label, relative time, msgCount, `⌂` when cwd differs); tapping calls `store.newAgentChat(hostId:cwd:resumeSessionId: s.id)` (thread `store` + `hostId` into the view) and `model.closePicker()`.

- [ ] **Step 4: Run to verify it passes**

Run: `xcodebuild test -only-testing:TetherKitTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Agent/AgentChatModel.swift clients/apple/TetherKit/Sources/TetherKit/Views/AgentChatView.swift clients/apple/TetherKit/Sources/TetherKit/SessionStore.swift clients/apple/TetherKit/Sources/TetherKit/Terminal/TerminalPipeline.swift clients/apple/TetherKit/Sources/TetherKit/Noise/NoiseSessionClient.swift clients/apple/TetherKit/Tests/TetherKitTests
git commit -m "feat(ios): /resume picker opens a past session in a new tab with history"
```

---

### Task 15: Full verification + release

**Files:** none (verification).

- [ ] **Step 1: Server suite**

Run: `bun --cwd apps/server run test`
Expected: all PASS.

- [ ] **Step 2: Desktop suite + lint (Biome + both typechecks)**

Run: `bun --cwd apps/desktop run test` then `bun lint` then `bun format`
Expected: PASS; no diffs after format (or commit the format).

- [ ] **Step 3: iOS build + tests on macbuild**

Run: `scripts/build-xcframework.sh` then `xcodebuild test -project clients/apple/Tether.xcodeproj -scheme TetherIOS -destination 'platform=iOS Simulator,name=iPhone 15' -only-testing:TetherKitTests`
Expected: PASS. (Regenerate the xcframework so Swift links the current core — stale-xcframework hides changes.)

- [ ] **Step 4: Manual smoke**

Desktop: `bun dev:server` + `bun dev:desktop`, open an agent chat, type `/` (palette), run `/clear`, `/model` (switch, verify strip updates), `/resume` (pick a past session, verify a new tab opens with history and continues).

- [ ] **Step 5: Release**

Invoke the `releasing-tether` skill from `main` after this branch merges green. Do not tag from the feature branch.

---

## Self-Review

**Spec coverage:**
- Wire protocol (3 additions) → Tasks 6/8/9 (`agent.model`), 12/13/14 (`agent.list-sessions`, `agent.sessions`, `resumeClaudeSessionId`). ✓
- Client dispatch (per-client table + matcher) → Tasks 1/4. ✓
- Palette UI + keyboard (desktop) / tap list (iOS) → Tasks 3/5. ✓
- `/model` (static aliases + passthrough, per-chat + sticky default, `--model`) → Tasks 6/7/8/9. ✓
- `/resume` (slug, list, translate, new-tab, history) → Tasks 10/11/12/13/14. ✓
- Error handling (empty/corrupt jsonl, empty list, tolerant parse) → Tasks 10/11 tests. ✓
- Migration append-only (v13), config setting → Task 7. ✓
- Testing layers + gates → Task 15. ✓

**Placeholder scan:** Task 8 and Task 12 leave test *arrange/act* to be filled from the file's existing `agent.start` scaffold rather than inventing a fake harness that may not match — the impl code is complete; the note points at the concrete scaffold to copy. All impl steps carry real code.

**Type consistency:** `AgentCommand`/`dispatchDraft`/`matchCommands` names match across desktop (Task 1) and iOS (Task 4). `buildClaudeArgs` (Task 6) consumed by the driver only. `ClaudeSessionMeta` fields (`id,label,mtimeMs,msgCount,cwd`) identical server (Task 10) ↔ desktop (Task 13) ↔ iOS (Task 14). `TranslatedMessage` (Task 11) consumed by Task 12. `registry.start(id,cwd,opts)` signature (Task 7) matches call sites (Tasks 8, 12). `AgentSnapshot` additions (`paletteIndex`, `pendingPicker`, `resumeSessions`) consistent across Tasks 2/13.
