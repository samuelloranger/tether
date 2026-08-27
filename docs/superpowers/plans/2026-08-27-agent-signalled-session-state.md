# Agent-Signalled Session State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a finished agent turn from raising the same "needs attention" alarm as an agent that is genuinely blocked, by adding a `done` activity state and a control channel the program itself can signal on.

**Architecture:** Three layers. (1) `sessionActivity.ts` gains a fourth state `done`, tracks where a `waiting` came from, and lets an OSC-sourced `waiting` decay to `done` after silence. (2) A new loopback control endpoint `POST /control/signal` plus a `tether signal` CLI let a program declare its own state authoritatively; a session that has signalled becomes *agent-driven*, the byte heuristics stop guessing for it, and — critically — its duplicate OSC push is suppressed. (3) Both native clients learn the fourth state.

**Tech Stack:** Bun + Hono + zod + bun:sqlite (server, bun:test); protobuf via buf (`crates/tether-proto/schema/wire.proto`); React 19 + vite + xterm.js (`apps/desktop`, bun:test + Biome); Swift 6 / SwiftUI (`clients/apple`, XCTest); Rust (`crates/tether-core`, `apps/desktop/src-tauri`, cargo test).

**Spec:** `docs/superpowers/specs/2026-08-27-agent-signalled-session-state.md`

**Revision note:** This is revision 2. Revision 1 was reviewed adversarially and had 4 blockers and 19 further defects; every one is corrected here. The corrections that changed the plan's *shape* are called out in **Review corrections** at the end — read that section if you are wondering why a task is ordered the way it is.

## Global Constraints

- **`bun --cwd <dir> run <script>` DOES NOT WORK.** On Bun 1.4.0 it prints `Usage: bun run [flags] <file or script>` and **exits 0**, so it looks green having run nothing. The flag must come *after* `run`. Every command in this plan uses the working form:
  - `bun run --cwd apps/server test [filter]`
  - `bun run --cwd apps/server typecheck`
  - `bun run --cwd apps/desktop test`
  - `bun run --cwd apps/desktop typecheck`
  - `bun run --cwd apps/server build`
  - `CLAUDE.md` currently teaches the broken form. Fixing it is out of scope for this plan; do not copy commands from it.
- Never set `TETHER_DB_PATH` for a suite run — `test-preload.ts` gives each process its own temp DB and its own `TETHER_PRESENT_CONTROL_TOKEN_FILE`.
- **Run `bun run --cwd apps/server typecheck` before every server commit.** `bun test` does not typecheck, so a broken exhaustive `Record` passes tests and ships a red build.
- Formatting is Biome: 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before every commit touching TS/TSX.
- Bun ≥ 1.3.14 is the floor; dev and CI run 1.4.x.
- Swift builds and tests run on the user's Mac (`macbuild`) over SSH — there is no Swift toolchain on this Linux host.
- **Do not edit `apps/mobile`.** It is retired.
- `apps/desktop/src/App.tsx` is at the Biome `noExcessiveLinesPerFile` limit (400). Do not add lines to it.
- New protobuf enum values are append-only; never renumber. The generated output under `apps/server/src/server/proto/gen/` **is committed**; CI never runs buf.
- No Co-Authored-By trailers in commit messages.

## File Structure

**Server (`apps/server/src/server/`)**

| File | Change | Responsibility |
|---|---|---|
| `sessionActivity.ts` | modify | `done` in `Activity`; `waitingSource` + `agentDriven`; `recordSignal`; decay; latch release |
| `sessionActivity.test.ts` | modify | The new state, the decay, the latch and its release |
| `proto/wireCodec.ts` | modify | Map `done` ↔ `ACTIVITY_DONE` (**same commit as the type widening**) |
| `proto/wireCodec.test.ts` | modify | Add `'done'` to the existing round-trip loop |
| `notifications.ts` | modify | `{ type: 'done'; title?; body? }` |
| `config.ts` | modify | `triggers.done`, **`z.boolean().default(false)`** |
| `config.test.ts` | modify | Default, patch, and the old-row-preserved regression |
| `push.ts` | modify | Word the `done` push |
| `push.test.ts` | modify | Wording + default-off gate |
| `ptyHolder.ts` | modify | Export `signalSession()` |
| `signal.api.test.ts` | **create** | Route test, driving the composed `app` |
| `routes/signal.ts` | **create** | `POST /control/signal` |
| `app.ts` | modify | Register `signalRoutes` |
| `signalCli.ts` | **create** | `parseSignalArgs` / `runSignal` / `claudeHookSnippet` |
| `signalCli.test.ts` | **create** | Arg parsing, POST body, hook snippet |
| `main.ts` | modify | `signal` subcommand + help |

**Protocol**

| File | Change |
|---|---|
| `crates/tether-proto/schema/wire.proto` | `ACTIVITY_DONE = 4` |
| `apps/server/src/server/proto/gen/**` | Regenerated, committed |

**Rust**

| File | Change |
|---|---|
| `crates/tether-core/src/server_config.rs` | `TriggersConfig.done` (`#[serde(default)]`) + partial |
| `crates/tether-core/src/notify_rules.rs` | `SessionActivity::Done` |
| `crates/tether-core/tests/e2e_terminal.rs` | Widen the hardcoded activity set |
| `apps/desktop/src-tauri/src/commands/config.rs` | `Some("done")` arm |

**Desktop (`apps/desktop/src/`)**

| File | Change |
|---|---|
| `activity.ts` | `'done'` in `SessionActivity` + `DotKey`, label "finished" |
| `activity.test.ts` | **create** — no coverage exists today |
| `litTheme.ts` | `LitState` `'done'`, `BLOOM.done`, `litColor` arm |
| `preferences.ts` | `HeatColors.done` on all three palettes |
| `frameHandler.ts` | Accept `'done'` |
| `index.css` | `.dot-done`, `--heat-done`, `[data-lit='done']` |
| `serverSettingsModel.ts` | `triggers.done` on the `ServerConfig` type |
| `serverSettingsModel.test.ts` | Fixture gains `done` |
| `ServerSettingsScreen.tsx` | `done` toggle row |
| `litTheme.test.ts` | New cases |

**iOS (`clients/apple/TetherKit/`)**

| File | Change |
|---|---|
| `Sources/TetherKit/SessionActivity.swift` | `.done` case, label, colour |
| `Sources/TetherKit/Theme/TetherColors.swift` | `heatDone` |
| `Sources/TetherKit/Theme/LitTheme.swift` | `LitState.done`, `LitBloom.done`, arms |
| `Sources/TetherKit/Theme/TetherMotion.swift` | `heat(to:)` gains the `.done` arm |
| `Sources/TetherKit/Networking/ConfigClient.swift` | `done` (decode-tolerant) + partial + patch diff |
| `Sources/TetherKit/Views/ServerSettingsView.swift` | `done` toggle |
| `Tests/TetherKitTests/SessionActivityTests.swift`, `LitThemeTests.swift` | New cases |

**Docs**

| File | Change |
|---|---|
| `CLAUDE.md` | `tether signal`, the four-state vocabulary, `/control/signal` |
| `docs/data-flow.md` | **New** "Session activity" section (the file has no frame-vocabulary section today) |
| `DESIGN.md` | The fourth heat |

---

### Task 1: The `done` state, the wire, and the decay

**This is one atomic task on purpose.** `proto/wireCodec.ts:35` declares
`const ACTIVITY_TO_PROTO: Record<DomainActivity, Activity>` — an *exhaustive*
Record. Widening `Activity` without the map entry fails typecheck; adding the map
entry without widening `Activity` is an excess-property error. Neither half
compiles alone, so schema, regen, type, and map ship together.

**Files:**
- Modify: `crates/tether-proto/schema/wire.proto`
- Modify: `apps/server/src/server/proto/gen/**` (regenerated)
- Modify: `apps/server/src/server/proto/wireCodec.ts`
- Modify: `apps/server/src/server/sessionActivity.ts`
- Test: `apps/server/src/server/proto/wireCodec.test.ts`
- Test: `apps/server/src/server/sessionActivity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type Activity = 'working' | 'waiting' | 'done' | 'idle'`
  - `export type WaitingSource = 'signal' | 'osc' | 'tail'`
  - unchanged signatures for `recordOutput`, `recordOutputEvent`, `recordInput`, `getActivity`, `clearActivity`, `scanChunk`, `SILENCE_MS`

- [ ] **Step 1: Append the enum value and regenerate**

In `crates/tether-proto/schema/wire.proto`:

```proto
enum Activity {
  ACTIVITY_UNSPECIFIED = 0;
  ACTIVITY_WORKING = 1;
  ACTIVITY_WAITING = 2;
  ACTIVITY_IDLE = 3;
  // Finished a piece of work. Distinct from IDLE (a bare prompt, nothing
  // happened) and from WAITING (blocked, cannot proceed). Appended in v2.9.
  // A client built before this decodes the number and resolves it to null,
  // then picks the state up from the JSON session-list poll instead.
  ACTIVITY_DONE = 4;
}
```

Run from the repo root: `bun run gen:proto`
Expected: only files under `apps/server/src/server/proto/gen/` change. Confirm with `git status`.

- [ ] **Step 2: Write the failing tests**

In `apps/server/src/server/proto/wireCodec.test.ts:61`, add `'done'` to the
existing loop — do not add a new test, the file already round-trips every value
through its `one()` helper:

```ts
    for (const activity of ['working', 'waiting', 'idle', 'done'] as const) {
```

Append to `apps/server/src/server/sessionActivity.test.ts` (`recordOutput`,
`recordInput`, `getActivity`, `clearActivity`, `SILENCE_MS` are already imported
at the top of that file; `T0` is already defined):

```ts
describe('done state', () => {
  afterEach(() => {
    clearActivity('d1');
    clearActivity('d2');
    clearActivity('d3');
  });

  test('an OSC-sourced waiting settles to done once it is quiet and asks nothing', () => {
    recordOutput('d1', 'building\n', T0);
    recordOutput('d1', '\x1b]777;notify;Claude;Finished\x07', T0 + 100);
    expect(getActivity('d1', T0 + 200)).toBe('waiting');
    expect(getActivity('d1', T0 + 100 + SILENCE_MS)).toBe('done');
  });

  test('an OSC-sourced waiting that DOES ask something stays waiting', () => {
    recordOutput('d2', 'Do you want to proceed?\x07', T0);
    expect(getActivity('d2', T0 + SILENCE_MS)).toBe('waiting');
  });

  test('a tail-sourced waiting never decays', () => {
    recordOutput('d3', 'Continue? ', T0);
    expect(getActivity('d3', T0 + SILENCE_MS)).toBe('waiting');
    expect(getActivity('d3', T0 + SILENCE_MS * 4)).toBe('waiting');
  });

  test('typing does not disturb a done session, but its echo does', () => {
    recordOutput('d1', 'x\x07', T0);
    expect(getActivity('d1', T0 + SILENCE_MS)).toBe('done');
    // recordInput only answers a `waiting`. A finished session is not a
    // question, so there is nothing for a keystroke to answer.
    expect(recordInput('d1', T0 + SILENCE_MS + 1)).toBeNull();
    expect(recordOutput('d1', 'x', T0 + SILENCE_MS + 2)).toBe('working');
  });

  test('a done session that reaches a shell prompt goes idle', () => {
    recordOutput('d2', 'x\x07', T0);
    expect(getActivity('d2', T0 + SILENCE_MS)).toBe('done');
    recordOutput('d2', '\nsam@box ~ $ ', T0 + SILENCE_MS + 1);
    expect(getActivity('d2', T0 + SILENCE_MS * 3)).toBe('idle');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun run --cwd apps/server test sessionActivity wireCodec`
Expected: FAIL — `expected "done", received "waiting"`, and the proto round-trip returns null for `'done'`.

- [ ] **Step 4: Widen the type and the map together**

In `apps/server/src/server/sessionActivity.ts`, replace the `Activity` type:

```ts
/**
 * `waiting` and `done` are deliberately separate. `waiting` means BLOCKED —
 * a program that cannot proceed without an answer, and the only state allowed
 * to pull attention away from whatever you are looking at. `done` means a piece
 * of work completed and the output is worth a look. `idle` is neither: a bare
 * shell prompt where nothing has happened at all.
 */
export type Activity = 'working' | 'waiting' | 'done' | 'idle';

/**
 * Where a `waiting` came from, which decides whether it may decay.
 *
 * `osc` is a guess — a bell or an OSC 9/777 notification, which agents send on
 * completion just as readily as on a question. `tail` is a guess with evidence:
 * the last visible line actually looks like a prompt. `signal` is not a guess
 * at all: the program said so through `/control/signal`.
 */
export type WaitingSource = 'signal' | 'osc' | 'tail';
```

In `apps/server/src/server/proto/wireCodec.ts`, both maps in the same edit:

```ts
const ACTIVITY_TO_PROTO: Record<DomainActivity, Activity> = {
  working: Activity.WORKING,
  waiting: Activity.WAITING,
  idle: Activity.IDLE,
  done: Activity.DONE,
};

const ACTIVITY_FROM_PROTO: Partial<Record<Activity, DomainActivity>> = {
  [Activity.WORKING]: 'working',
  [Activity.WAITING]: 'waiting',
  [Activity.IDLE]: 'idle',
  [Activity.DONE]: 'done',
};
```

- [ ] **Step 5: Extend the per-session state**

In `sessionActivity.ts`, the state interface and its constructor:

```ts
interface SessionActivityState {
  activity: Activity;
  since: number;
  lastOutputAt: number;
  tail: string;
  residual: string;
  waitingSource: WaitingSource | null;
  agentDriven: boolean;
}
```

```ts
    st = {
      activity: 'working',
      since: now,
      lastOutputAt: now,
      tail: '',
      residual: '',
      waitingSource: null,
      agentDriven: false,
    };
```

and `transition` learns to carry the source:

```ts
function transition(
  st: SessionActivityState,
  next: Activity,
  now: number,
  source: WaitingSource | null = null,
): Activity | null {
  if (st.activity === next) return null;
  st.activity = next;
  st.since = now;
  st.waitingSource = next === 'waiting' ? source : null;
  return next;
}
```

- [ ] **Step 6: Tag the OSC-sourced waiting**

In `recordOutputEvent`, the only change to the strongest-signal chain is the
source argument. Leave the surrounding comments exactly as they are:

```ts
  if (scan.bell || scan.notify) activity = transition(st, 'waiting', now, 'osc');
```

Do **not** add `done` to the `longJob` expression: nothing in `recordOutputEvent`
can produce `done`, so the arm would be dead code.

- [ ] **Step 7: Let a guessed waiting decay, and let a prompt end it**

Replace `getActivity`:

```ts
// Read the current classification. Applies the silence heuristics lazily —
// the 4s client poll of /api/sessions is the clock, so no server-side timer.
//
// This mutates on read, and its ONLY caller is the session-list route, so a
// decay is never broadcast over the WebSocket: an attached client learns of it
// on its next poll, up to 4s later. That is deliberate — the alternative is a
// timer per session for a change nobody is waiting on.
export function getActivity(id: string, now = Date.now()): Activity | null {
  const st = stateBySession.get(id);
  if (!st) return null;
  if (now - st.lastOutputAt < getConfig().session.silenceMs) return st.activity;
  if (st.activity === 'working') {
    // An agent speaks for itself, so its silence is not evidence of a question.
    if (!st.agentDriven && WAITING_RE.test(st.tail)) transition(st, 'waiting', now, 'tail');
    else if (PROMPT_RE.test(st.tail)) releaseToIdle(st, now);
  } else if (st.activity === 'waiting' && st.waitingSource === 'osc') {
    // A bell or an OSC notification is not evidence of a question — agents fire
    // the same sequence when they finish. If the screen is not actually asking
    // anything after the silence window, this was a completion, and leaving it
    // lit as an alarm is the bug this whole change exists to fix.
    if (!WAITING_RE.test(st.tail)) transition(st, 'done', now);
  } else if (st.activity === 'done' && PROMPT_RE.test(st.tail)) {
    releaseToIdle(st, now);
  }
  return st.activity;
}

/**
 * A bare shell prompt is the one unambiguous signal that whatever was running
 * has exited — including the agent. So this is also where the agent-driven
 * latch is released: without it, quitting Claude Code would leave the session
 * permanently exempt from the heuristics, stuck on whatever state it died in.
 */
function releaseToIdle(st: SessionActivityState, now: number): void {
  st.agentDriven = false;
  transition(st, 'idle', now);
}
```

Leave `recordInput` alone. It answers a `waiting` and nothing else — a finished
session is not a question, and the echo of whatever you type moves it to
`working` through the normal output path one chunk later.

- [ ] **Step 8: Run the tests and the typecheck**

Run: `bun run --cwd apps/server test sessionActivity wireCodec`
Expected: PASS.

Run: `bun run --cwd apps/server typecheck`
Expected: clean.

Run: `bun run --cwd apps/server test`
Expected: PASS (363 tests across 55 files at time of writing).

- [ ] **Step 9: Commit**

```bash
bun format
git add crates/tether-proto/schema/wire.proto apps/server/src/server/proto apps/server/src/server/sessionActivity.ts apps/server/src/server/sessionActivity.test.ts
git commit -m "feat(server): add a done activity state and let a guessed waiting decay into it"
```

---

### Task 2: `recordSignal`, the agent-driven latch, and the duplicate push

A program that tells the server what it is doing beats every regex in the file.
It also replaces the OSC channel — **suppressing that duplicate push is what
makes this change actually fix the reported bug**, and is not optional.

**Files:**
- Modify: `apps/server/src/server/sessionActivity.ts`
- Test: `apps/server/src/server/sessionActivity.test.ts`

**Interfaces:**
- Consumes: `Activity`, `WaitingSource`, `transition`, `releaseToIdle` (Task 1).
- Produces:
  - `export type SignalState = 'working' | 'waiting' | 'done'`
  - `export function recordSignal(id: string, state: SignalState, now?: number): Activity | null`
  - `export function isAgentDriven(id: string): boolean`
  - `recordOutputEvent` returns `notify: null` for an agent-driven session

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/server/sessionActivity.test.ts`, adding
`recordSignal`, `isAgentDriven`, and `recordOutputEvent` to the imports:

```ts
describe('recordSignal', () => {
  afterEach(() => {
    clearActivity('s1');
    clearActivity('s2');
    clearActivity('s3');
  });

  test('a signal sets the state and reports the transition', () => {
    recordOutput('s1', 'work\n', T0);
    expect(recordSignal('s1', 'done', T0 + 10)).toBe('done');
    expect(getActivity('s1', T0 + 20)).toBe('done');
  });

  test('a signal for the same state is not a transition', () => {
    recordSignal('s1', 'done', T0);
    expect(recordSignal('s1', 'done', T0 + 10)).toBeNull();
  });

  test('once a session has signalled, a bell no longer forces waiting', () => {
    recordSignal('s2', 'done', T0);
    recordOutput('s2', '\x07', T0 + 10);
    expect(getActivity('s2', T0 + 20)).toBe('done');
  });

  test('once a session has signalled, silence stops being read as a question', () => {
    recordOutput('s3', 'Continue? ', T0);
    recordSignal('s3', 'working', T0 + 1);
    expect(getActivity('s3', T0 + SILENCE_MS * 2)).toBe('working');
  });

  test('real output from an agent-driven session still means working', () => {
    recordSignal('s1', 'done', T0);
    expect(recordOutput('s1', 'more output\n', T0 + 10)).toBe('working');
  });

  test('a signalled waiting never decays', () => {
    recordSignal('s2', 'waiting', T0);
    expect(getActivity('s2', T0 + SILENCE_MS * 4)).toBe('waiting');
  });

  test('a shell prompt releases the latch, so the session can go quiet again', () => {
    recordSignal('s3', 'done', T0);
    expect(isAgentDriven('s3')).toBe(true);
    recordOutput('s3', '\nsam@box ~ $ ', T0 + 10);
    expect(getActivity('s3', T0 + SILENCE_MS * 2)).toBe('idle');
    expect(isAgentDriven('s3')).toBe(false);
  });

  test('an agent-driven session stops raising its duplicate OSC push', () => {
    // The whole bug: Claude Code emits OSC 777 when it FINISHES, and
    // ptyHolder turns any notify payload into an oscNotify push. Once the
    // program has its own signal channel that push is a duplicate of the
    // signal, and it is the one the user actually complained about.
    const before = recordOutputEvent('s1', '\x1b]777;notify;Claude;Finished\x07', T0);
    expect(before.notify).not.toBeNull();
    clearActivity('s1');
    recordSignal('s1', 'done', T0);
    const after = recordOutputEvent('s1', '\x1b]777;notify;Claude;Finished\x07', T0 + 10);
    expect(after.notify).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd apps/server test sessionActivity`
Expected: FAIL — `recordSignal is not a function`.

- [ ] **Step 3: Implement the signal entry point**

Add to `apps/server/src/server/sessionActivity.ts`, after `recordInput`:

```ts
/**
 * The states a program may claim for itself. `idle` is missing on purpose: it
 * describes a shell prompt, which is the server's observation to make, not the
 * program's claim — and it is the observation that releases the latch.
 */
export type SignalState = 'working' | 'waiting' | 'done';

/**
 * A program declaring its own state, through `/control/signal`.
 *
 * This latches the session as agent-driven, and from then on the byte
 * heuristics stop guessing for it. Mixing the two sources produces flapping:
 * Claude Code emits the same OSC 777 when it finishes as when it asks, so the
 * scanner would immediately re-classify a signalled `done` as `waiting`, which
 * is exactly the confusion the signal exists to remove. The latch is released
 * when the session reaches a shell prompt — see `releaseToIdle`.
 */
export function recordSignal(id: string, state: SignalState, now = Date.now()): Activity | null {
  const st = getState(id, now);
  st.agentDriven = true;
  return transition(st, state, now, state === 'waiting' ? 'signal' : null);
}

/** Whether this session is currently speaking for itself. */
export function isAgentDriven(id: string): boolean {
  return stateBySession.get(id)?.agentDriven ?? false;
}
```

- [ ] **Step 4: Make the output path defer to the latch**

In `recordOutputEvent`, guard the bell/notify arm and drop the duplicate notify
payload. Both changes are required; the second is the one that fixes the bug:

```ts
  let activity: Activity | null;
  if ((scan.bell || scan.notify) && !st.agentDriven)
    activity = transition(st, 'waiting', now, 'osc');
  else if (scan.promptMark === 'A') activity = transition(st, 'idle', now);
  else if (scan.promptMark === 'C') activity = transition(st, 'working', now);
  else if (scan.tail === null)
    activity = fresh ? st.activity : null; // pure escape chunk — no evidence
  // Plain visible output = the program is doing something. A fresh session
  // reports its first classification even without a change, so clients get an
  // initial frame.
  else activity = transition(st, 'working', now) ?? (fresh ? st.activity : null);
  return {
    // An agent that signals has a better channel than its own OSC stream, and
    // ptyHolder turns any notify payload into a push. Passing it through would
    // deliver the completion alarm this change exists to remove, alongside the
    // signal's own (default-silent) one.
    notify: st.agentDriven ? null : scan.notify,
    activity,
    longJob:
      previousActivity === 'working' &&
      (activity === 'idle' || activity === 'waiting') &&
      now - previousSince >= getConfig().longJobSeconds * 1000,
  };
```

Keep the property order the file already uses; the snippet above shows the
values, not a mandate to reorder keys.

**Known gap, accept it:** the first turn after the hooks are installed may still
push once. The OSC and the `Stop` hook both fire at the end of a turn and their
order is not guaranteed, so the OSC may arrive before the latch is set. Every
subsequent turn is clean.

- [ ] **Step 5: Skip the heuristics for an agent-driven session**

In `getActivity`, the `!st.agentDriven` guard on the `WAITING_RE` promotion added
in Task 1 Step 7 already does this. Do **not** add an early `return st.activity`
for `agentDriven` — that would also skip the `PROMPT_RE` check, and the latch
would never release.

- [ ] **Step 6: Run the tests and the typecheck**

Run: `bun run --cwd apps/server test sessionActivity`
Expected: PASS.

Run: `bun run --cwd apps/server typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
bun format
git add apps/server/src/server/sessionActivity.ts apps/server/src/server/sessionActivity.test.ts
git commit -m "feat(server): let a program declare its own state and drop its duplicate OSC push"
```

---

### Task 3: The `done` notification trigger

**Files:**
- Modify: `apps/server/src/server/notifications.ts`
- Modify: `apps/server/src/server/config.ts`
- Modify: `apps/server/src/server/push.ts`
- Test: `apps/server/src/server/config.test.ts`
- Test: `apps/server/src/server/push.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `NotificationEvent` gains `{ type: 'done'; title?: string; body?: string }`
  - `Config['triggers']` gains `done: boolean`, default `false`, **optional on input**

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/server/push.test.ts`. The real fixtures are `CTX` (a
const) and `cfg(overrides)` (a function) — there is no `baseConfig` and no `ctx`:

```ts
test('a done push is silent unless the user opted in', () => {
  expect(buildPushContent({ type: 'done' }, CTX, cfg())).toBeNull();
});

test('a done push says what finished', () => {
  const config = cfg({ triggers: { ...DEFAULT_CONFIG.triggers, done: true } });
  expect(buildPushContent({ type: 'done' }, CTX, config)?.body).toBe('Finished');
});

test('a done push prefers the words the program supplied', () => {
  const config = cfg({ triggers: { ...DEFAULT_CONFIG.triggers, done: true } });
  const content = buildPushContent({ type: 'done', title: 'Claude', body: 'Tests pass' }, CTX, config);
  expect(content?.title).toBe('alpha · Claude');
  expect(content?.body).toBe('Tests pass');
});
```

Append to `apps/server/src/server/config.test.ts`:

```ts
test('the done trigger is off by default', () => {
  expect(DEFAULT_CONFIG.triggers.done).toBe(false);
});

test('the done trigger can be patched on', async () => {
  const next = await patchConfig({ triggers: { done: true } });
  expect(next.triggers.done).toBe(true);
  expect(next.triggers.waiting).toBe(true);
});

test('a stored row written before done existed keeps the choices it does have', () => {
  // readTopLevel falls back to the WHOLE default block on a parse failure, so a
  // required `done` would silently flip a user's `waiting: false` back on when
  // they upgrade. The zod default is what keeps the old row parseable.
  setSetting(
    'config.triggers',
    JSON.stringify({ waiting: false, oscNotify: true, exit: true, longJob: true }),
  );
  resetConfigCache();
  expect(getConfig().triggers.waiting).toBe(false);
  expect(getConfig().triggers.done).toBe(false);
});
```

Add `setSetting` (from `./db`), `getConfig`, and `resetConfigCache` to that
file's imports if they are not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd apps/server test config push`
Expected: FAIL — `done` is not a known trigger key.

- [ ] **Step 3: Add the event shape**

In `apps/server/src/server/notifications.ts`:

```ts
export type NotificationEvent =
  | { type: 'waiting' }
  | { type: 'done'; title?: string; body?: string }
  | { type: 'oscNotify'; title?: string; body?: string }
  | { type: 'exit'; exitCode?: number }
  | { type: 'longJob'; seconds: number };
```

- [ ] **Step 4: Add the trigger, with a zod default**

In `apps/server/src/server/config.ts`:

```ts
    triggers: z.object({
      waiting: z.boolean(),
      // `.default(false)` rather than a bare boolean, and not for style: every
      // stored `config.triggers` row predates this key, and `readTopLevel`
      // reacts to a parse failure by discarding the WHOLE section for defaults.
      // A required key would silently flip a user's `waiting: false` back on.
      // The default makes the key optional on input while the parsed type stays
      // `boolean`, so nothing downstream changes.
      done: z.boolean().default(false),
      oscNotify: z.boolean(),
      exit: z.boolean(),
      longJob: z.boolean(),
    }),
```

and in `DEFAULT_CONFIG`:

```ts
  triggers: { waiting: true, done: false, oscNotify: true, exit: true, longJob: true },
```

- [ ] **Step 5: Word the push**

In `apps/server/src/server/push.ts`. `buildPushContent` already gates on
`cfg.triggers[event.type]`, so the `done` key needs no new gate:

```ts
  const title = `${cfg.identity.name} · ${
    (event.type === 'oscNotify' || event.type === 'done') && event.title
      ? event.title
      : ctx.sessionTitle
  }`;
  const body =
    event.type === 'waiting'
      ? 'Waiting for input'
      : event.type === 'done'
        ? (event.body ?? 'Finished')
        : event.type === 'oscNotify'
          ? (event.body ?? event.title ?? 'Notification')
          : event.type === 'exit'
            ? `Session exited${event.exitCode === undefined ? '' : ` with code ${event.exitCode}`}`
            : `Job ran for ${event.seconds} seconds`;
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `bun run --cwd apps/server test config push`
Expected: PASS.

Run: `bun run --cwd apps/server typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
bun format
git add apps/server/src/server/notifications.ts apps/server/src/server/config.ts apps/server/src/server/config.test.ts apps/server/src/server/push.ts apps/server/src/server/push.test.ts
git commit -m "feat(server): add an opt-in notification trigger for a finished turn"
```

---

### Task 4: The `/control/signal` endpoint

**Files:**
- Create: `apps/server/src/server/routes/signal.ts`
- Create: `apps/server/src/server/signal.api.test.ts`
- Modify: `apps/server/src/server/ptyHolder.ts`
- Modify: `apps/server/src/server/app.ts`

**Interfaces:**
- Consumes: `recordSignal`, `SignalState` (Task 2); `{ type: 'done' }` (Task 3); `hasControlToken` from `routes/presentations.ts`.
- Produces:
  - `export function signalSession(id: string, state: SignalState, words?: { title?: string; body?: string }): boolean` in `ptyHolder.ts` — false when no such session exists, and **nothing is recorded in that case**
  - `export const signalRoutes: Hono` in `routes/signal.ts`

- [ ] **Step 1: Write the failing test**

The repo has **no** tests under `routes/`; every HTTP route test lives at the top
level as `*.api.test.ts` and drives the composed app. Create
`apps/server/src/server/signal.api.test.ts`, mirroring
`presentations.api.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { app, presentationControlToken } from './app';
import { clearActivity, getActivity } from './sessionActivity';

function post(body: unknown, token?: string): Promise<Response> {
  return app.request('/control/signal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Tether-Present-Control': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('rejects a request with no control token', async () => {
  expect((await post({ sessionId: 'sig-1', state: 'done' })).status).toBe(401);
});

test('rejects a state it does not model', async () => {
  const res = await post({ sessionId: 'sig-1', state: 'idle' }, presentationControlToken);
  expect(res.status).toBe(400);
});

test('rejects a missing sessionId', async () => {
  expect((await post({ state: 'done' }, presentationControlToken)).status).toBe(400);
});

test('refuses an unknown session rather than inventing state for it', async () => {
  clearActivity('sig-nope');
  const res = await post({ sessionId: 'sig-nope', state: 'done' }, presentationControlToken);
  expect(res.status).toBe(404);
  // The important half: a typo must not leave a permanent entry behind.
  expect(getActivity('sig-nope')).toBeNull();
});
```

There is no live PTY in a unit test, so a *successful* signal cannot be asserted
here — `signalSession` returns false for every id. Task 9 Step 2 covers the happy
path end to end against a real session.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd apps/server test signal`
Expected: FAIL — cannot resolve `./routes/signal`.

- [ ] **Step 3: Add the broadcast + notify helper**

In `apps/server/src/server/ptyHolder.ts`. `broadcast` is defined and exported at
line 78, `notify` is the module-private function at line 94, and `getSession`
is imported from `./db` at line 6 — all three are in scope:

```ts
/**
 * A program declaring its own state, arriving from `/control/signal`.
 *
 * The same three things an output-driven transition does: record it, tell the
 * attached clients, and raise a notification. Unlike the output path this is
 * not a guess, so `waiting` here means genuinely blocked and `done` means
 * genuinely finished — which is why the two have separate triggers.
 *
 * The session lookup comes FIRST and gates everything. `recordSignal` creates
 * per-session state for whatever id it is handed, so signalling a typo would
 * otherwise leak a map entry that nothing ever clears.
 */
export function signalSession(
  id: string,
  state: SignalState,
  words?: { title?: string; body?: string },
): boolean {
  if (!getSession(id)) return false;
  const activity = recordSignal(id, state);
  if (activity) broadcast(id, { type: 'activity', activity });
  if (state === 'waiting') notify(id, { type: 'waiting' });
  else if (state === 'done') notify(id, { type: 'done', ...words });
  return true;
}
```

Add `recordSignal` and the `SignalState` type to the existing
`from './sessionActivity'` import.

- [ ] **Step 4: Write the route**

Create `apps/server/src/server/routes/signal.ts`:

```ts
import { Hono } from 'hono';
import { signalSession } from '../ptyHolder';
import type { SignalState } from '../sessionActivity';
import { hasControlToken } from './presentations';

const STATES: readonly SignalState[] = ['working', 'waiting', 'done'];

function isSignalState(value: unknown): value is SignalState {
  return typeof value === 'string' && (STATES as readonly string[]).includes(value);
}

function words(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, limit) : undefined;
}

export const signalRoutes = new Hono();

/**
 * A program telling the server what it is doing.
 *
 * Authed by the same loopback control token as `/control/presentations`, and
 * with the same reach — the server binds every interface, so this is not
 * loopback-only, but it is no wider than the control surface that already
 * exists. The session id comes from `TETHER_SESSION_ID`, which `pty.ts` exports
 * into every shell, so a hook two processes deep can still name its own tab.
 */
signalRoutes.post('/control/signal', async (c) => {
  if (!hasControlToken(c.req.header('X-Tether-Present-Control')))
    return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.sessionId !== 'string' || !body.sessionId)
    return c.json({ error: 'missing sessionId' }, 400);
  if (!isSignalState(body.state))
    return c.json({ error: `state must be one of ${STATES.join(', ')}` }, 400);
  const known = signalSession(body.sessionId, body.state, {
    title: words(body.title, 100),
    body: words(body.body, 400),
  });
  if (!known) return c.json({ error: 'unknown session' }, 404);
  return c.json({ ok: true });
});
```

- [ ] **Step 5: Register the route**

In `apps/server/src/server/app.ts`, beside the other route imports and
registrations:

```ts
import { signalRoutes } from './routes/signal';
```
```ts
app.route('/', signalRoutes);
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `bun run --cwd apps/server test signal`
Expected: PASS.

Run: `bun run --cwd apps/server test`
Expected: PASS.

Run: `bun run --cwd apps/server typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
bun format
git add apps/server/src/server/routes/signal.ts apps/server/src/server/signal.api.test.ts apps/server/src/server/ptyHolder.ts apps/server/src/server/app.ts
git commit -m "feat(server): add a control endpoint for a program to declare its state"
```

---

### Task 5: The `tether signal` CLI and the Claude Code hook snippet

**Files:**
- Create: `apps/server/src/server/signalCli.ts`
- Create: `apps/server/src/server/signalCli.test.ts`
- Modify: `apps/server/src/server/main.ts`

**Interfaces:**
- Consumes: the `/control/signal` contract from Task 4.
- Produces:
  - `export type SignalArgs = { kind: 'send'; state: SignalState; title?: string; body?: string } | { kind: 'hooks' }`
  - `export function parseSignalArgs(argv: string[]): SignalArgs`
  - `export function claudeHookSnippet(): string` — pure JSON, no trailing prose
  - `export interface SignalDeps { baseUrl: string; tokenFile: string; sessionId?: string; fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }`
  - `export async function runSignal(args: SignalArgs, deps: SignalDeps): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/server/signalCli.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeHookSnippet, parseSignalArgs, runSignal } from './signalCli';

function tokenFile(token = 'tok'): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tether-signal-')), 'token');
  writeFileSync(file, `${token}\n`);
  return file;
}

describe('parseSignalArgs', () => {
  test('reads a bare state', () => {
    expect(parseSignalArgs(['done'])).toEqual({ kind: 'send', state: 'done' });
  });

  test('reads the optional words', () => {
    expect(parseSignalArgs(['done', '--title', 'Claude', '--body', 'Tests pass'])).toEqual({
      kind: 'send',
      state: 'done',
      title: 'Claude',
      body: 'Tests pass',
    });
  });

  test('rejects a state it does not model', () => {
    expect(() => parseSignalArgs(['idle'])).toThrow();
  });

  test('rejects a flag with no value', () => {
    expect(() => parseSignalArgs(['done', '--title'])).toThrow();
  });

  test('reads the hooks subcommand', () => {
    expect(parseSignalArgs(['hooks'])).toEqual({ kind: 'hooks' });
  });
});

describe('runSignal', () => {
  test('posts the session id from the environment with the control token', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    await runSignal(
      { kind: 'send', state: 'done', body: 'Tests pass' },
      {
        baseUrl: 'http://127.0.0.1:8085',
        tokenFile: tokenFile('secret'),
        sessionId: 'term-7',
        fetch: async (url, init) => {
          seen = { url: String(url), init };
          return new Response('{}', { status: 200 });
        },
      },
    );
    expect(seen!.url).toBe('http://127.0.0.1:8085/control/signal');
    expect((seen!.init!.headers as Record<string, string>)['X-Tether-Present-Control']).toBe(
      'secret',
    );
    expect(JSON.parse(String(seen!.init!.body))).toEqual({
      sessionId: 'term-7',
      state: 'done',
      body: 'Tests pass',
    });
  });

  test('refuses to guess when there is no session id', async () => {
    await expect(
      runSignal(
        { kind: 'send', state: 'done' },
        {
          baseUrl: 'http://127.0.0.1:8085',
          tokenFile: tokenFile(),
          fetch: async () => new Response('{}'),
        },
      ),
    ).rejects.toThrow(/TETHER_SESSION_ID/);
  });

  test('reports a rejected request', async () => {
    await expect(
      runSignal(
        { kind: 'send', state: 'done' },
        {
          baseUrl: 'http://127.0.0.1:8085',
          tokenFile: tokenFile(),
          sessionId: 'term-7',
          fetch: async () => new Response('nope', { status: 401 }),
        },
      ),
    ).rejects.toThrow(/401/);
  });
});

describe('claudeHookSnippet', () => {
  test('maps the two distinct hook events to the two distinct states', () => {
    const snippet = JSON.parse(claudeHookSnippet());
    expect(JSON.stringify(snippet.hooks.Notification)).toContain('tether signal waiting');
    expect(JSON.stringify(snippet.hooks.Stop)).toContain('tether signal done');
  });

  test('is pure JSON a user can paste', () => {
    expect(() => JSON.parse(claudeHookSnippet())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd apps/server test signalCli`
Expected: FAIL — cannot resolve `./signalCli`.

- [ ] **Step 3: Write the CLI module**

Create `apps/server/src/server/signalCli.ts`:

```ts
import { readFileSync } from 'node:fs';
import type { SignalState } from './sessionActivity';

export type SignalArgs =
  | { kind: 'send'; state: SignalState; title?: string; body?: string }
  | { kind: 'hooks' };

const STATES: readonly string[] = ['working', 'waiting', 'done'];

const USAGE =
  'Usage: tether signal <working|waiting|done> [--title T] [--body B] | tether signal hooks';

export function parseSignalArgs(argv: string[]): SignalArgs {
  if (argv[0] === 'hooks') {
    if (argv.length > 1) throw new Error(USAGE);
    return { kind: 'hooks' };
  }
  if (!argv[0] || !STATES.includes(argv[0])) throw new Error(USAGE);
  const out: Extract<SignalArgs, { kind: 'send' }> = {
    kind: 'send',
    state: argv[0] as SignalState,
  };
  for (let i = 1; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (!value || (argv[i] !== '--title' && argv[i] !== '--body')) throw new Error(USAGE);
    if (argv[i] === '--title') out.title = value;
    if (argv[i] === '--body') out.body = value;
  }
  return out;
}

export interface SignalDeps {
  /** Loopback origin of the running daemon, chosen by main.ts from the listener plan. */
  baseUrl: string;
  tokenFile: string;
  /** `TETHER_SESSION_ID`, exported into every session by pty.ts. */
  sessionId?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export async function runSignal(args: SignalArgs, deps: SignalDeps): Promise<void> {
  if (args.kind === 'hooks') {
    console.log(claudeHookSnippet());
    // Printed after the JSON, not inside it, so the block above stays pasteable.
    console.log(
      '\n# Paste the "hooks" block into ~/.claude/settings.json.\n' +
        '# Then remove "preferredNotifChannel": "ghostty" if you have it — the\n' +
        '# hooks replace it, and tether suppresses the duplicate OSC push anyway.',
    );
    return;
  }
  // Refuse rather than guess. There is no safe default session: signalling the
  // wrong tab is worse than not signalling at all, because it marks a shell you
  // are not looking at as finished.
  if (!deps.sessionId) {
    throw new Error('No TETHER_SESSION_ID — run this from inside a tether session.');
  }
  const token = readFileSync(deps.tokenFile, 'utf8').trim();
  const res = await (deps.fetch ?? fetch)(`${deps.baseUrl}/control/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tether-Present-Control': token },
    body: JSON.stringify({
      sessionId: deps.sessionId,
      state: args.state,
      ...(args.title ? { title: args.title } : {}),
      ...(args.body ? { body: args.body } : {}),
    }),
    // Loopback to our own self-signed certificate. The control token, not the
    // certificate chain, is what authorises this call.
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  if (!res.ok) throw new Error(`Tether signal failed (${res.status}). Is tether running?`);
}

/**
 * The Claude Code hook configuration, printed for the user to paste into
 * `~/.claude/settings.json`.
 *
 * Printed rather than written: this edits a file the user owns and may have
 * hand-tuned, and a merge this CLI gets wrong costs them their whole hook
 * setup. The two events are what make this worth doing at all — `Notification`
 * fires when Claude is blocked on permission or input, `Stop` when a turn ends,
 * and those are exactly the two things the OSC 777 stream cannot tell apart.
 */
export function claudeHookSnippet(): string {
  const hook = (state: 'waiting' | 'done') => [
    { hooks: [{ type: 'command', command: `tether signal ${state}` }] },
  ];
  return JSON.stringify({ hooks: { Notification: hook('waiting'), Stop: hook('done') } }, null, 2);
}
```

- [ ] **Step 4: Wire the subcommand**

In `apps/server/src/server/main.ts`, add a case next to `present` (which is at
lines 304-320 and whose listener-plan handling this copies; `resolveListenerPlan`
is imported at line 16 and `PRESENT_CONTROL_TOKEN_FILE` at line 13):

```ts
  case 'signal': {
    const { parseSignalArgs, runSignal } = await import('./signalCli');
    try {
      const plan = resolveListenerPlan();
      await runSignal(parseSignalArgs(process.argv.slice(3)), {
        baseUrl:
          plan.httpPort === null
            ? `https://127.0.0.1:${plan.httpsPort}`
            : `http://127.0.0.1:${plan.httpPort}`,
        tokenFile: PRESENT_CONTROL_TOKEN_FILE,
        sessionId: process.env.TETHER_SESSION_ID,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    break;
  }
```

and one line in `help()`, under the `present` line:

```
  signal           Tell tether this session is working / waiting / done
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun run --cwd apps/server test signalCli`
Expected: PASS.

Run: `bun run --cwd apps/server typecheck`
Expected: clean.

- [ ] **Step 6: Verify the hooks output by hand**

`hooks` returns before touching the network or the token file, so no daemon is
needed:

```bash
bun run --cwd apps/server build
apps/server/dist/tether signal hooks
```

Expected: a pasteable `{"hooks": {...}}` block with `tether signal waiting`
under `Notification` and `tether signal done` under `Stop`, followed by the
three `#` note lines.

- [ ] **Step 7: Commit**

```bash
bun format
git add apps/server/src/server/signalCli.ts apps/server/src/server/signalCli.test.ts apps/server/src/server/main.ts
git commit -m "feat(server): add a tether signal CLI and a Claude Code hook snippet"
```

---

### Task 6: The desktop client learns `done`

**Files:**
- Modify: `apps/desktop/src/activity.ts`
- Create: `apps/desktop/src/activity.test.ts` (**no coverage exists today**)
- Modify: `apps/desktop/src/litTheme.ts`
- Modify: `apps/desktop/src/preferences.ts`
- Modify: `apps/desktop/src/frameHandler.ts`
- Modify: `apps/desktop/src/index.css`
- Modify: `apps/desktop/src/serverSettingsModel.ts`
- Modify: `apps/desktop/src/serverSettingsModel.test.ts`
- Modify: `apps/desktop/src/ServerSettingsScreen.tsx`
- Test: `apps/desktop/src/litTheme.test.ts`

**Interfaces:**
- Consumes: the server's `activity: 'done'` and `triggers.done`.
- Produces: `'done'` in `SessionActivity`, `DotKey`, `LitState`; `HeatColors.done`; `ServerConfig['triggers'].done`.

- [ ] **Step 1: Create the missing test file**

`apps/desktop/src/activity.test.ts` does not exist — `activityDotKey` and
`activityLabel` have no coverage at all. Create it:

```ts
import { describe, expect, it } from 'bun:test';
import { activityDotKey, activityLabel } from './activity';

describe('activityDotKey', () => {
  it('carries the server classification straight through', () => {
    expect(activityDotKey('running', 'working', false)).toBe('working');
    expect(activityDotKey('running', 'waiting', false)).toBe('waiting');
    expect(activityDotKey('running', 'idle', false)).toBe('idle');
  });

  it('gives a finished session its own dot, not idle', () => {
    expect(activityDotKey('running', 'done', false)).toBe('done');
  });

  it('is stopped whatever the server last said', () => {
    expect(activityDotKey('stopped', 'done', true)).toBe('stopped');
    expect(activityDotKey('stopped', 'working', true)).toBe('stopped');
  });

  it('falls back to recency when the server has no classification', () => {
    expect(activityDotKey('running', null, true)).toBe('working');
    expect(activityDotKey('running', null, false)).toBe('idle');
  });
});

describe('activityLabel', () => {
  it('reads as finished, not as needing you', () => {
    expect(activityLabel('done')).toBe('finished');
    expect(activityLabel('waiting')).toBe('needs input');
  });
});
```

Append to `apps/desktop/src/litTheme.test.ts` (`dark` is already defined there as
`UI_THEMES['default-dark']`):

```ts
describe('the done state', () => {
  it('carries through to its own lit state', () => {
    expect(litStateFor('done')).toBe('done');
  });

  it('wears the success colour, not the ember one', () => {
    expect(litColor(dark, 'done')).toBe(dark.colors.success);
    expect(litColor(dark, 'done')).not.toBe(dark.heat.waiting);
  });

  it('glows quieter than a shell that is blocked', () => {
    expect(Number.parseFloat(litVars(dark, 'done')['--rim'])).toBeLessThan(
      Number.parseFloat(litVars(dark, 'waiting')['--rim']),
    );
  });

  it('does not fire the arrival swell — finishing is not an alarm', () => {
    expect(shouldAnnounceArrival('working', 'done', true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd apps/desktop test`
Expected: FAIL — `'done'` is not assignable to `DotKey`.

- [ ] **Step 3: Widen the activity model**

In `apps/desktop/src/activity.ts`:

```ts
export type SessionActivity = 'working' | 'waiting' | 'done' | 'idle';

export type DotKey = 'stopped' | 'waiting' | 'working' | 'done' | 'idle';

export function activityDotKey(
  status: 'running' | 'stopped',
  activity: SessionActivity | null | undefined,
  live: boolean,
): DotKey {
  if (status === 'stopped') return 'stopped';
  if (activity === 'waiting') return 'waiting';
  if (activity === 'working') return 'working';
  if (activity === 'done') return 'done';
  if (activity === 'idle') return 'idle';
  return live ? 'working' : 'idle';
}

export function activityLabel(key: DotKey): string {
  switch (key) {
    case 'stopped':
      return 'stopped';
    case 'waiting':
      return 'needs input';
    case 'working':
      return 'working';
    case 'done':
      return 'finished';
    case 'idle':
      return 'idle';
  }
}
```

- [ ] **Step 4: Give it one colour, used everywhere**

`done` wears the flavour's existing **`success`** token. Not a new hex, and not
the accent: `success` is already the app's "this went well" colour, and reusing
it keeps the drawer dot and the chrome tint the same green — `.dot-done` reads
`var(--success)`, and `litColor` must resolve to the same value or the dot and
the bloom beside it would be two different greens.

In `apps/desktop/src/preferences.ts`, add `done` to the `HeatColors` interface
and to all three palettes, pointing at the same value each palette's `success`
already uses (`p.green` for Catppuccin, `#6ee7a8` dark, `#1c7a4f` light):

```ts
    heat: { working: p.yellow, waiting: p.red, done: p.green, cool: p.blue },
```
```ts
    heat: { working: '#f2b34c', waiting: '#ff7050', done: '#6ee7a8', cool: '#7c8cf8' },
```
```ts
    heat: { working: '#8a5a00', waiting: '#c4381c', done: '#1c7a4f', cool: '#4353d0' },
```

In `apps/desktop/src/litTheme.ts`:

```ts
export type LitState = 'working' | 'waiting' | 'done' | 'idle' | 'none';
```

```ts
export function litStateFor(dot: DotKey | null): LitState {
  switch (dot) {
    case 'working':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'done':
      return 'done';
    case 'idle':
      return 'idle';
    default:
      // 'stopped' and null both mean "nothing is running here".
      return 'none';
  }
}
```

```ts
const BLOOM: Record<LitState, { b1: string; b2: string; b3: string; rim: string }> = {
  working: { b1: '13%', b2: '6%', b3: '2%', rim: '55%' },
  waiting: { b1: '9%', b2: '4%', b3: '1.5%', rim: '46%' },
  // Between waiting and idle: warmer than a shell that is merely alive, quieter
  // than one that is blocked. Finishing is worth noticing and nothing more.
  done: { b1: '8%', b2: '3.5%', b3: '1.2%', rim: '36%' },
  idle: { b1: '7%', b2: '3%', b3: '1%', rim: '30%' },
  none: { b1: '0%', b2: '0%', b3: '0%', rim: '0%' },
};
```

```ts
    case 'done':
      return theme.heat.done;
```

Leave `shouldAnnounceArrival` untouched — it tests `next === 'waiting'`, so
`done` correctly gets no swell.

- [ ] **Step 5: Accept the frame**

`apps/desktop/src/frameHandler.ts:75` is a single line today. Replace it with:

```ts
    if (
      activity === 'working' ||
      activity === 'waiting' ||
      activity === 'done' ||
      activity === 'idle'
    ) {
```

- [ ] **Step 6: Style the dot and time the heat**

In `apps/desktop/src/index.css`: a token beside the heat durations at ~line 88:

```css
  --heat-done: 300ms;
```

the state block after `[data-lit='waiting']` at ~line 419:

```css
.app-shell[data-lit='done'] {
  --heat: var(--heat-done);
}
```

the dot after `.dot-waiting` at ~line 845:

```css
.dot-done {
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 16%, transparent);
}
```

and `--heat-done: 120ms;` inside the existing `prefers-reduced-motion` block at
~line 2064, beside the other heat tokens at 2077-2079. Do **not** add a `*` rule
there — shortening the tokens is the whole mechanism.

- [ ] **Step 7: Add the trigger to the settings model and the screen**

`ServerSettingsScreen.tsx:212` does `draft.triggers[key]`, so the type has to
learn the key first. In `apps/desktop/src/serverSettingsModel.ts:4`:

```ts
  triggers: { waiting: boolean; done: boolean; oscNotify: boolean; exit: boolean; longJob: boolean };
```

In `apps/desktop/src/serverSettingsModel.test.ts:13`, the fixture:

```ts
  triggers: { waiting: true, done: false, oscNotify: true, exit: true, longJob: true },
```

In `apps/desktop/src/ServerSettingsScreen.tsx:203`, one row:

```tsx
            ['waiting', 'Agent needs input'],
            ['done', 'Agent finishes a turn'],
            ['oscNotify', 'Alerts from programs'],
```

- [ ] **Step 8: Run the tests and the typecheck**

Run: `bun run --cwd apps/desktop test`
Expected: PASS.

Run: `bun run --cwd apps/desktop typecheck`
Expected: clean. A non-exhaustive `switch` over `DotKey` or `LitState` elsewhere
surfaces here — add the `done` arm; never a `default` that swallows it.

- [ ] **Step 9: Verify it in the browser**

```bash
bun dev:desktop
```

In devtools:

```js
document.querySelector('.app-shell').dataset.lit = 'done'
getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--lit')
```

Expected: the chrome crossfades to green over ~300ms and `--lit` reports the
flavour's `success` value. Set it back to `working` and confirm it crossfades
again.

- [ ] **Step 10: Commit**

```bash
bun format
git add apps/desktop/src
git commit -m "feat(desktop): show a finished session as its own state"
```

---

### Task 7: The Rust core and the Tauri shell learn `done`

`notify_rules::SessionActivity` has exactly one production consumer, and it is
**not** in `crates/` — it is `apps/desktop/src-tauri`, whose `match` currently
drops `"done"` on the floor.

**Files:**
- Modify: `crates/tether-core/src/server_config.rs`
- Modify: `crates/tether-core/src/notify_rules.rs`
- Modify: `crates/tether-core/tests/e2e_terminal.rs`
- Modify: `apps/desktop/src-tauri/src/commands/config.rs`

**Interfaces:**
- Consumes: the server's `triggers.done` and `activity: "done"`.
- Produces: `TriggersConfig.done`, `TriggersConfigPartial.done`, `SessionActivity::Done`.

- [ ] **Step 1: Write the failing tests**

Append to the `mod tests` block in `crates/tether-core/src/server_config.rs`:

```rust
    #[test]
    fn done_trigger_defaults_off_on_an_older_server() {
        let json = r#"{
            "push": { "enabled": true },
            "triggers": { "waiting": true, "oscNotify": true, "exit": true, "longJob": false },
            "longJobSeconds": 300,
            "identity": { "name": "Homelab", "color": "#f9e2af" },
            "session": {
                "defaultShell": "bash", "defaultCwd": "/home/sam",
                "scrollbackRows": 2000, "silenceMs": 15000
            }
        }"#;
        let cfg: ServerConfig = serde_json::from_str(json).unwrap();
        assert!(!cfg.triggers.done);
    }

    #[test]
    fn done_trigger_round_trips_when_the_server_sends_it() {
        let json = r#"{ "waiting": true, "done": true, "oscNotify": false,
                        "exit": true, "longJob": true }"#;
        let triggers: TriggersConfig = serde_json::from_str(json).unwrap();
        assert!(triggers.done);
        assert!(serde_json::to_string(&triggers)
            .unwrap()
            .contains("\"done\":true"));
    }
```

Append to the `mod tests` block in `crates/tether-core/src/notify_rules.rs`. The
predicate is `waiting_edge_deserves_notify` (line 108) — there is no
`should_notify`:

```rust
    #[test]
    fn a_finished_session_is_not_a_waiting_edge() {
        assert!(!waiting_edge_deserves_notify(
            Some(SessionActivity::Working),
            Some(SessionActivity::Done),
            false
        ));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd crates/tether-core && cargo test`
Expected: FAIL — no field `done`, no variant `Done`.

- [ ] **Step 3: Add the field and the variant**

In `crates/tether-core/src/server_config.rs`:

```rust
pub struct TriggersConfig {
    pub waiting: bool,
    /// Absent on a server older than v2.9 — off rather than a parse failure.
    #[serde(default)]
    pub done: bool,
    pub osc_notify: bool,
    pub exit: bool,
    pub long_job: bool,
}
```

and in `TriggersConfigPartial`, beside the others:

```rust
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
```

In `crates/tether-core/src/notify_rules.rs`:

```rust
pub enum SessionActivity {
    Working,
    Waiting,
    /// Finished a piece of work. Deliberately NOT a notification edge: the
    /// server decides whether a completion is worth a push, through the
    /// separate `done` trigger, and these rules only ever cared about a shell
    /// that is blocked.
    Done,
    Idle,
}
```

- [ ] **Step 4: Widen the hardcoded activity set in the e2e test**

`crates/tether-core/tests/e2e_terminal.rs:274` asserts against a closed list:

```rust
    assert!(
        ["working", "waiting", "idle", "done"].contains(&activity.as_str()),
        "unexpected activity value: {activity}"
    );
```

- [ ] **Step 5: Teach the Tauri shell the new string**

`apps/desktop/src-tauri/src/commands/config.rs:238` is the only production
consumer of `SessionActivity`, and its `_ => None` silently swallows `"done"`:

```rust
    fn parse(value: Option<String>) -> Option<SessionActivity> {
        match value.as_deref() {
            Some("working") => Some(SessionActivity::Working),
            Some("waiting") => Some(SessionActivity::Waiting),
            Some("done") => Some(SessionActivity::Done),
            Some("idle") => Some(SessionActivity::Idle),
            _ => None,
        }
    }
```

- [ ] **Step 6: Run both crates' tests**

Run: `cd crates/tether-core && cargo test`
Expected: PASS.

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cargo fmt --manifest-path crates/tether-core/Cargo.toml
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml
git add crates/tether-core apps/desktop/src-tauri
git commit -m "feat(core): model the done activity and its notification trigger"
```

---

### Task 8: The iOS client learns `done`

Write the code here, build and test it on `macbuild`.

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/SessionActivity.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Theme/TetherColors.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Theme/LitTheme.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Theme/TetherMotion.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Networking/ConfigClient.swift`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Views/ServerSettingsView.swift`
- Test: `clients/apple/TetherKit/Tests/TetherKitTests/SessionActivityTests.swift`
- Test: `clients/apple/TetherKit/Tests/TetherKitTests/LitThemeTests.swift`

**Interfaces:**
- Consumes: the server's `activity: "done"` and `triggers.done`.
- Produces: `SessionActivityDot.done`, `LitState.done`, `LitBloom.done`, `TetherColors.heatDone`, `ServerTriggersConfig.done`, `ServerConfigPatch.PartialTriggers.done`.

- [ ] **Step 1: Write the failing tests**

Append to `SessionActivityTests.swift`:

```swift
  func test_done_is_its_own_dot_not_idle() {
    XCTAssertEqual(
      SessionActivityLogic.dotKey(status: "running", activity: "done", live: false),
      .done
    )
  }

  func test_done_reads_as_finished() {
    XCTAssertEqual(SessionActivityLogic.label(.done), "finished")
  }

  func test_a_stopped_shell_is_still_stopped() {
    XCTAssertEqual(
      SessionActivityLogic.dotKey(status: "stopped", activity: "done", live: true),
      .stopped
    )
  }
```

Append to `LitThemeTests.swift`:

```swift
  func test_done_carries_through_to_its_own_lit_state() {
    XCTAssertEqual(LitTheme.state(for: .done), .done)
  }

  func test_done_glows_quieter_than_blocked() {
    XCTAssertLessThan(LitBloom.done.rim, LitBloom.waiting.rim)
    XCTAssertGreaterThan(LitBloom.done.rim, LitBloom.idle.rim)
  }

  func test_done_does_not_fire_the_arrival_swell() {
    XCTAssertFalse(
      TetherMotion.pulses(from: .working, to: .done, settled: true, reduceMotion: false)
    )
  }
```

- [ ] **Step 2: Add the dot case**

In `SessionActivity.swift` — the enum, the string mapping, the label, the colour:

```swift
public enum SessionActivityDot: String, Equatable, Sendable {
  case stopped
  case waiting
  case working
  case done
  case idle
}
```
```swift
    case "done": return .done
```
```swift
    case .done: return "finished"
```
```swift
    case .done:
      TetherColors.heatDone
```

- [ ] **Step 3: Add the colour**

In `Theme/TetherColors.swift`, beside the other heat entries at lines 37-39. The
values are the app's success green, matching the desktop's `success` token:

```swift
  public static let heatDone = dynamic(dark: 0x6E_E7_A8, light: 0x1C_7A_4F)
```

- [ ] **Step 4: Add the lit state**

In `Theme/LitTheme.swift`:

```swift
public enum LitState: String, Equatable, Sendable {
  case working
  case waiting
  case done
  case idle
  case none
}
```
```swift
  // Between waiting and idle: warmer than a shell that is merely alive, quieter
  // than one that is blocked. Finishing is worth noticing and nothing more.
  public static let done = LitBloom(b1: 0.08, b2: 0.035, b3: 0.012, rim: 0.36)
```
```swift
    case .done: .done
```
(in `LitBloom.forState`)
```swift
    case .done: .done
```
(in `LitTheme.state(for:)`)
```swift
    case .done: TetherColors.heatDone
```
(in `LitTheme.color(for:)`)
```swift
    case .done: "finished"
```
(in `LitTheme.label(for:)`)

Note the house style difference: `LitTheme`'s switches use implicit returns,
while `TetherMotion.heat` uses explicit `return`. Match whichever file you are in.

- [ ] **Step 5: Give the motion tokens the new state**

`TetherMotion.heat(to:reduceMotion:)` switches exhaustively over `LitState` and
will not compile until `done` is handled. A completion is news and should arrive,
not seep:

```swift
      case .working: return decelerate(ignite)
      case .waiting: return decelerate(arrive)
      case .done: return decelerate(arrive)
      case .idle, .none: return .easeOut(duration: cool)
```

Leave `pulses(from:to:settled:reduceMotion:)` alone — it tests `new == .waiting`,
so `done` correctly gets no swell.

- [ ] **Step 6: Teach the config client the trigger**

In `Networking/ConfigClient.swift`. A custom `init(from:)` is required: Swift's
synthesised decoder throws on a missing key, so a new client would fail its whole
config fetch against an older server.

```swift
public struct ServerTriggersConfig: Codable, Equatable, Sendable {
  public var waiting: Bool
  /// Absent on a server older than v2.9 — decode as off rather than failing the
  /// whole config fetch over one missing flag.
  public var done: Bool
  public var oscNotify: Bool
  public var exit: Bool
  public var longJob: Bool

  public init(waiting: Bool, done: Bool = false, oscNotify: Bool, exit: Bool, longJob: Bool) {
    self.waiting = waiting
    self.done = done
    self.oscNotify = oscNotify
    self.exit = exit
    self.longJob = longJob
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    waiting = try c.decode(Bool.self, forKey: .waiting)
    done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
    oscNotify = try c.decode(Bool.self, forKey: .oscNotify)
    exit = try c.decode(Bool.self, forKey: .exit)
    longJob = try c.decode(Bool.self, forKey: .longJob)
  }
}
```

Defaulting `done` in the memberwise init keeps every existing call site
compiling. Then extend `PartialTriggers` — the property, the `init` parameter,
the assignment, and `isEmpty`:

```swift
    public var done: Bool?
```
```swift
      done: Bool? = nil,
```
```swift
      self.done = done
```
```swift
    public var isEmpty: Bool {
      waiting == nil && done == nil && oscNotify == nil && exit == nil && longJob == nil
    }
```

Serialise it beside `obj["waiting"]`:

```swift
      if let done = triggers.done { obj["done"] = done }
```

And diff it in `patchForDraft`, beside the `waiting` line:

```swift
  if config.triggers.done != draft.triggers.done { triggers.done = draft.triggers.done }
```

- [ ] **Step 7: Add the settings toggle**

In `Views/ServerSettingsView.swift`, between the `waiting` (lines 201-206) and
`oscNotify` (lines 209-214) toggles. Read those two first and copy their exact
enclosing form — the snippet below shows the binding, not the surrounding
modifiers:

```swift
      Toggle("Agent finishes a turn", isOn: Binding(
        get: { draft.triggers.done },
        set: { v in updateDraft { $0.triggers.done = v } }
      ))
```

- [ ] **Step 8: Build and test on the Mac**

Task 7 changed `crates/`, so the XCFramework must be rebuilt or the app links the
old core:

```bash
ssh macbuild 'cd /tmp/tether-signal && git fetch && git checkout <branch> && \
  PROFILE=debug caffeinate -s bash scripts/build-xcframework.sh 2>&1 | tail -5'
```

Create the worktree at `/tmp/tether-signal` first if it does not exist.

```bash
ssh macbuild 'cd /tmp/tether-signal/clients/apple/TetherKit && \
  xcodebuild test -scheme TetherKit \
    -destination "platform=iOS Simulator,name=iPhone 16" 2>&1 | tail -30'
```

Expected: `TEST SUCCEEDED`, with the new cases counted.

- [ ] **Step 9: Build the app itself**

```bash
ssh macbuild 'cd /tmp/tether-signal/clients/apple && \
  xcodebuild -scheme TetherIOS -destination "platform=iOS Simulator,name=iPhone 16" \
    build 2>&1 | tail -20'
```

Expected: `BUILD SUCCEEDED`. A non-exhaustive switch over `SessionActivityDot` or
`LitState` anywhere in the app surfaces here — add the `done` arm, not a
`default`.

- [ ] **Step 10: Commit**

```bash
git add clients/apple
git commit -m "feat(ios): show a finished session as its own state"
```

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/data-flow.md`
- Modify: `DESIGN.md`

- [ ] **Step 1: Record the CLI and the endpoint**

In `CLAUDE.md`, **Server as a daemon**:

```
`serve` (default, foreground) plus `start | stop | restart | status | logs | set-password | present | signal | update | version`
```

In **HTTP API surface**, add `/control/signal` beside `/control/presentations`.

In **Data flow**, after the push-notifications paragraph:

```markdown
**Session activity:** `sessionActivity.ts` classifies each session `working` /
`waiting` / `done` / `idle` from the PTY byte stream. `waiting` means BLOCKED —
the only state allowed to pull attention away from the active tab. `done` means
a piece of work finished; its own colour, its own notification trigger, off by
default. A program can override the guesswork with
`tether signal <working|waiting|done>` (`TETHER_SESSION_ID` is exported into
every session; the CLI posts to `/control/signal` with the present-control
token). A session that has signalled is *agent-driven*: the byte heuristics stop
guessing for it and its duplicate OSC push is suppressed, until it reaches a
shell prompt, which releases the latch. `tether signal hooks` prints the Claude
Code configuration mapping its `Notification` hook to `waiting` and its `Stop`
hook to `done`.
```

- [ ] **Step 2: Add a section to the data-flow doc**

`docs/data-flow.md` is 24 lines with sections `Connect & replay` / `Live output`
/ `Holder protocol` / `Pruning`, and the word `activity` appears nowhere in it.
There is no frame-vocabulary section to extend — add one after **Live output**:

```markdown
## Session activity

Every output chunk is also scanned for what the foreground program is *doing*:
`working`, `waiting` (blocked on an answer), `done` (finished a piece of work),
or `idle` (a bare shell prompt). Transitions are broadcast as an `activity`
frame and reported by `GET /api/sessions`.

A bell or an OSC 9/777 notification is only a guess — agents emit the same
sequence on completion as on a question — so a `waiting` that came from one
decays to `done` after `silenceMs` of quiet if the screen is not actually asking
anything. That decay happens lazily on the session-list read, so an attached
client sees it on its next poll rather than as a frame.

A program can skip the guessing entirely: `tether signal <state>` posts to
`/control/signal` and the session becomes *agent-driven*, which disables the
heuristics and suppresses its now-duplicate OSC push until the session reaches a
shell prompt.
```

- [ ] **Step 3: Record the fourth heat**

In `DESIGN.md:47`, extend the state list:

```
a session becoming live (`working` 260ms / `waiting` 340ms / `done` 300ms)
arrives on a decelerating curve
```

and after the "One authored moment" paragraph:

```markdown
`done` gets colour but no swell. Finishing is worth a look, not an interruption —
the swell is reserved for the one state that cannot proceed without you.
```

- [ ] **Step 4: Verify the docs build**

Run: `bun docs:build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md DESIGN.md docs
git commit -m "docs: record the done state and the tether signal channel"
```

---

### Task 10: Full-stack verification

- [ ] **Step 1: Lint and test everything**

```bash
bun lint
bun run --cwd apps/server test
bun run --cwd apps/desktop test
(cd crates/tether-core && cargo test)
(cd apps/desktop/src-tauri && cargo test)
```

Expected: all clean. Confirm each test command actually printed a pass count —
a bare usage message means the command form is wrong.

- [ ] **Step 2: Drive the real loop by hand**

```bash
bun run --cwd apps/server build
TETHER_PORT=8099 TETHER_TLS=off TETHER_DB_PATH=/tmp/tether-signal-e2e.db \
  apps/server/dist/tether serve &
```

Start a session through the API, then from inside it:

```bash
tether signal done --body "Tests pass"
```

Confirm `GET /api/sessions` reports `"activity":"done"` for it. Then
`tether signal waiting` and confirm it reports `"activity":"waiting"` and is
still `waiting` past the 15s silence window. Then exit the program back to a
shell prompt and confirm it settles to `"idle"` — that is the latch releasing.

Stop the server with `kill <pid>` (read the pid from `jobs -p` or `pgrep -f`;
`kill %1` needs interactive job control) and remove `/tmp/tether-signal-e2e.db`.

- [ ] **Step 3: Confirm the original bug is gone**

Two checks, and the second is the one that matters.

In a session that has **not** signalled:

```bash
printf '\033]777;notify;Claude;Finished\007'
```

Expected: the dot goes ember immediately, then settles to the green `done` dot
on its own within `silenceMs` — where before it stayed red until you typed.

In a session that **has** signalled (run `tether signal done` first), send the
same escape and confirm **no push is delivered** — `activityEvent.notify` is
suppressed for an agent-driven session, and that suppression is what actually
fixes the complaint. Watch the server log for the absence of a push attempt.

- [ ] **Step 4: Commit anything the verification changed**

```bash
bun format
git add -A
git commit -m "fix: fallout from full-stack verification"
```

---

## Review corrections

Revision 1 was reviewed against the real code. The corrections that changed this
plan's shape, so a reader knows why it looks like this:

1. **Every command was broken.** `bun --cwd <dir> run <script>` prints usage and
   exits 0 on Bun 1.4.0. Every verification step in revision 1 would have
   reported success having run nothing. All commands now use
   `bun run --cwd <dir> <script>`.
2. **Task order was wrong and unfixable by reordering.** `ACTIVITY_TO_PROTO` is
   an exhaustive `Record<DomainActivity, Activity>`, so widening the type and
   adding the map entry must be the same commit. The proto work is now folded
   into Task 1 rather than being a later task.
3. **The plan did not fix the bug.** The push a finished Claude turn raises is an
   `oscNotify`, not a `waiting` — `flushHolderOutput` checks `notify` first and
   `triggers.oscNotify` defaults on. Revision 1's guard only suppressed the state
   transition, so all ten tasks would have shipped with the alarm intact.
   Task 2 Step 4 now drops the notify payload for an agent-driven session, and
   Task 10 Step 3 verifies it.
4. **The latch had no exit, and deadlocked.** Revision 1 cleared `done` on
   keystroke and early-returned from `getActivity` for agent-driven sessions, so
   typing into a finished tab left it amber forever — the same stickiness bug the
   spec opens by complaining about. `recordInput` is now left alone, and a shell
   prompt releases the latch through `releaseToIdle`.
5. **A required `done` key would have silently reset users' triggers.**
   `readTopLevel` discards the whole section on a parse failure, so a user's
   `waiting: false` would flip back on at upgrade. Now `z.boolean().default(false)`,
   with a regression test.
6. **Missing scope:** `apps/desktop/src/serverSettingsModel.ts` (types the
   trigger set), `apps/desktop/src-tauri/src/commands/config.rs` (the only
   production consumer of `SessionActivity`, whose `match` dropped `"done"`), and
   `crates/tether-core/tests/e2e_terminal.rs` (a hardcoded three-value list).
7. **Wrong facts, now corrected:** `apps/desktop/src/activity.test.ts` did not
   exist (create, not append); `push.test.ts`'s fixtures are `CTX` and `cfg()`,
   not `baseConfig`/`ctx`; `wireCodec.test.ts` round-trips through a `one()`
   helper in a loop, so the change is one array element; the Rust predicate is
   `waiting_edge_deserves_notify`; `docs/data-flow.md` had no section to extend;
   the `done` palette values were invented and are now the existing `success`
   token, which also stops the dot and the chrome being two different greens.
8. **Dropped as dead code:** adding `done` to the `longJob` expression. Nothing
   in `recordOutputEvent` can produce `done`.
9. **`recordSignal` could leak map entries** for any string handed to it.
   `signalSession` now looks the session up first and the route answers 404.
10. **The decay is never broadcast.** True, and acceptable, but now stated
    explicitly in `getActivity`'s comment rather than left for a reader to find.
