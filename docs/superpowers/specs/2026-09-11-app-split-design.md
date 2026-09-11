# App.tsx Split — Design

**Date:** 2026-09-11
**Status:** approved, ready for planning
**Scope:** `apps/desktop/src/App.tsx` only. No behavior change.

## Problem

`App.tsx` is 741 lines, the largest file in the workspace. About 620 of them sit
inside a single `App()` function holding 16 hooks. It carries two Biome
suppressions to exist at all:

- `lint/style/noExcessiveLinesPerFile` on the file
- `lint/complexity/noExcessiveLinesPerFunction` on `App()`

The domain reorg (#183, #184) gave every other desktop file a home and a size
that fits in one screen. `App.tsx` is the file that did not improve. It mixes
six unrelated responsibilities:

| Lines | Responsibility |
|---|---|
| 1–67 | imports (67 lines) |
| 69–120 | two generic browser hooks + three pure helpers |
| 123–210 | app state, view-state refs, two effects |
| 212–321 | seven pane/view mutation operations + keyboard shortcuts |
| 323–371 | four session-launch flows |
| 373–407 | misc effects and derived memos |
| 409–501 | six early-return screens |
| 503–741 | the entire main render tree |

Nothing in this file is covered by a test today.

## Goal

`App.tsx` becomes a composition root of roughly 110 lines. Every extracted piece
lands in the domain folder the reorg established — no new top-level directories.
Both suppressions are deleted. Behavior is byte-identical, proven by golden
render snapshots captured before any code moves.

## Non-goals

- No visual change, no prop renames, no dependency additions.
- No change to `useTetherDesktop`, `useWorkspace`, `useGitPanel`, or any child
  component's interface.
- Not splitting `MainScreen` further into drawer/terminal/overlay regions. Those
  seams would be pure prop-threading: the overlays all read one `workspace`
  object, so splitting them gains no isolation and costs a layer.

## Testing strategy

The workspace has no DOM harness. 51 of its 52 tests are pure-logic `bun:test`
files; the one `.tsx` test (`agent/ProseMarkdown.test.tsx`) uses
`react-dom/server`'s `renderToString`. The repo convention, stated in
`CLAUDE.md`, is to keep pure logic in its own module so it is testable without
infrastructure.

A probe run on 2026-09-11 established that `renderToString` can render the
**entire `App` component** under `bun:test` with no DOM library:

- stub `globalThis.window` (`innerWidth`, `matchMedia`, `addEventListener`,
  `removeEventListener`, `location`) and `globalThis.localStorage`
- `mock.module('@/shell/useTetherDesktop', …)` to supply a fake `TetherDesktop`

This works because `renderToString` never runs effects, so xterm never
initializes, no WebGL context is requested, and no Tauri `invoke` is reached.
Only render-time code executes — which is exactly the code this refactor moves.
Output is state-sensitive: the empty state produced 1644 characters of HTML, a
single populated session pane produced 2291.

Two layers result:

**Layer 1 — golden render snapshots (initial render).** Written and committed
*before* any source file is touched. The 16 states listed below, each asserted with
`toMatchSnapshot()`. Every subsequent task must leave them byte-identical.

The golden states, each one snapshot:

| # | State |
|---|---|
| 1 | boot — `ready: false` |
| 2 | no hosts → pair-device screen |
| 3 | `screen: 'pair-device'` with hosts present |
| 4 | `screen: 'hosts'` |
| 5 | `screen: 'devices'` |
| 6 | `screen: 'settings'` |
| 7 | `screen: 'local-settings'` |
| 8 | main, no sessions — `TerminalEmpty` |
| 9 | main, one session, solo view |
| 10 | main, two-pane split view |
| 11 | main, sidebar docked (`sidebarPinned: true`, wide) |
| 12 | main, sidebar as overlay (`sidebarPinned: false`, `drawerOpen`) |
| 13 | main, `tabLayout: 'horizontal'` — tab bar instead of drawer |
| 14 | main, git open in `drawer` mode |
| 15 | main, git open in `review` mode |
| 16 | main, agent session pane (`kind: 'agent'`) |

**Layer 2 — pure unit tests (state transitions).** The view operations become
pure `ViewState → ViewState` functions with roughly 12 direct unit tests.

### What this does not cover

`renderToString` runs no effects and dispatches no events. Three behaviors stay
unverified by automation and require a manual smoke of the running app:

1. the reconcile effect that prunes dead sessions from views
2. the focused-pane → `selectSession` mirroring effect
3. the Cmd+D / Cmd+E / Cmd+W split and close shortcuts

This is a deliberate, stated limit — not an oversight to be engineered away.

## Module map

| File | Status | Lines | Responsibility |
|---|---|---|---|
| `shell/appRender.testkit.tsx` | new | ~90 | window/localStorage stubs, `TetherDesktop` mock factory, session and view fixtures |
| `App.golden.test.tsx` | new | ~150 | 16 `toMatchSnapshot()` cases across every screen and layout state |
| `pane/viewOps.ts` | new | ~130 | pure `ViewState → ViewState` operations |
| `pane/viewOps.test.ts` | new | ~150 | ~12 unit tests |
| `pane/useViewState.ts` | new | ~85 | state, ref, persistence, reconcile effect, keyboard effect |
| `session/useSessionLaunch.ts` | new | ~65 | the four launch/resume flows and their shared `agentChatFor` state |
| `platform/useViewport.ts` | new | ~35 | `useMediaScheme` + `useWideLayout`, moved verbatim |
| `shell/AppScreens.tsx` | new | ~85 | the five non-main screens |
| `shell/MainScreen.tsx` | new | ~250 | the main render tree |
| `session/residentKeys.ts` | modified | +22 | gains `liveSessionKeys` |
| `App.tsx` | rewritten | 741 → ~110 | composition root |

### `pane/viewOps.ts`

Pure functions, no React. Takes and returns `ViewState`; callers persist.
Absorbs `patchActiveView` and `statesEqual` from `App.tsx`.

```ts
splitPaneOp(state, paneId, dir, side): ViewState
closePaneOp(state, paneId, liveKeys): ViewState
fillPaneOp(state, paneId, ref, liveKeys): ViewState
focusPaneOp(state, paneId): ViewState
setRatioOp(state, branchId, ratio): ViewState
splitFromTabOp(state, key, dir, side, fallbackPaneId, liveKeys): ViewState
dropIntoPaneOp(state, paneId, intent, key, liveKeys): ViewState
openViewOp(state, viewId): ViewState
openSessionOp(state, key, fallbackPaneId, liveKeys): ViewState
addSoloViewOp(state, view): ViewState
reconcileOp(state, liveKeys): ViewState
```

These are thin by construction: `paneTree.ts` and `viewModel.ts` already hold
the tree algebra (`splitLeaf`, `closePane`, `setSession`, `moveSessionIntoView`,
`reconcileViews`). What moves here is the glue `App()` wrapped around them —
read current state, patch the active view, hand back a new state — which is
pure and only looked stateful because it was tangled with `useState`.

### `pane/useViewState.ts`

Holds `views`, `activeViewId`, `viewStateRef`, and `applyViews` (which persists
through `saveViews`). Owns the reconcile effect and the keyboard-shortcut
effect. Derives `activeView`, `tree`, `focusedPaneId`, `openSessionKeys`.
Returns the operations bound to current state.

**`liveKeys` is passed as a getter held in a ref.** It closes over
`app.sessions`, `app.healthByHost`, and `app.pendingAgentKeys()`, and four
operations call it. Passed as a plain callback it goes stale inside the effects,
which a typecheck will not catch — the same hazard `viewStateRef` already exists
to avoid, so it uses the same fix: store the getter in a ref refreshed on every
render.

**Declaration order must be preserved.** In today's `App.tsx` the keyboard
effect references `closePane_` at line 238, before its `const` declaration at
line 244. That is legal only because the effect body runs after the component
function completes. Both move into this hook together, in the same order.

### `shell/AppScreens.tsx`

Exports `appScreen(props): ReactNode | null` — a plain function, not a
component. Each of the five screens today repeats the same wrapper:

```tsx
<div className="app-shell centered" {...shellProps}>…<AlertModal /></div>
```

A component would have to return `null` for the main case, and `App` cannot
branch on an already-rendered element. A plain function returning the inner
element lets `App` apply the wrapper once, deleting the fivefold duplication:

```tsx
const screen = appScreen({ app, prefs, setPrefs, settingsHost });
if (screen) return <div className="app-shell centered" {...shellProps}>{screen}<AlertModal /></div>;
```

The boot state (`!app.ready`) stays in `App.tsx`: one case, different wrapper
class (`app-shell` without `centered`).

### `shell/MainScreen.tsx`

The main render tree, taking already-built objects as props rather than
rebuilding them: `app: TetherDesktop`, `workspace: WorkspaceState`,
`gitPanel: GitPanelState`, `modals: SessionModals`, plus view state, layout,
theme, prefs, and the launch callbacks. All four types are already exported.

### `session/residentKeys.ts`

`liveSessionKeys` moves here rather than into `viewOps.ts`. It has the same
shape as the existing `residentKeys` (pane tree plus session rows → session
keys), belongs to the session domain, and inherits that file's existing test.

## Verification

Per task: `bun run --cwd apps/desktop test` — 279 existing plus roughly 28 new —
and `bun run --cwd apps/desktop typecheck`. The golden snapshots must pass
unchanged at every commit after Task 1.

Before the PR: `bun lint`, `bun run --cwd apps/desktop build` (vite),
the full server suite, and `cargo test`.

Snapshot files live in `__snapshots__/` next to the test. No `.gitignore` rule
currently excludes them; they are committed deliberately, as the refactor's
contract.

## Risks

| Risk | Mitigation |
|---|---|
| Stale `liveKeys` closure inside extracted effects | getter held in a ref, refreshed each render; called out in the plan |
| `closePane_` TDZ ordering inverted during the move | both declarations move together, order preserved |
| A prop silently dropped while moving JSX | golden snapshots, committed before the move, fail on any HTML diff |
| Effect and event wiring unverified | stated limit; manual smoke of the three behaviors listed above |
| Snapshots accidentally regenerated to hide a regression | snapshot updates are reviewed as part of the diff; no task may update one |
