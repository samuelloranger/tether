# Desktop multi-terminal split view — design

**Date:** 2026-09-03
**Status:** Approved (design), pending implementation plan
**Board:** task #990
**Scope:** `apps/desktop` (Tauri + React + xterm.js frontend). No server, core, or iOS changes.

## Goal

Let the desktop client show **multiple live terminals at once** in a tiling split
layout, instead of one full-screen session with the rest hidden behind tabs. A
user can carve the screen into panes, drop any session (from any host) into any
pane, resize with dividers, and the layout survives an app restart.

## Decisions (locked)

| Question | Choice |
|---|---|
| Layout shape | Split panes (tiling), draggable dividers |
| Sessions per split | Any host mix — panes independent |
| Keyboard input | One focused pane at a time; others stream read-only |
| Build gestures | Both: split buttons + shortcuts **and** drag-to-side |
| Persistence | Persist the pane tree to localStorage |
| Close pane vs kill | Closing a pane only unsplits; the session keeps running |
| Empty pane | Shows a session picker (existing session or "new session"), does not auto-start |

Extra requested gestures:
- Drag a terminal tab toward a pane edge → a **ghost preview** shows where the
  split will land before you drop.
- Right-click a tab (focused or not) → context menu "Split right / left / up /
  down" that splits the focused pane in that direction and drops the tab's
  session into the new leaf.

## Current architecture (what we build on)

`ResidentTerminals.tsx` already mounts **every** resident session as a
`TerminalPane`, each streaming live over its own WebSocket. The Rust core
(`host_store` LRU cache) decides which sessions stay resident. Today all panes
are stacked absolutely at `inset:0`; CSS shows only the active one
(`.resident-pane.active { visibility: visible }`) and hides the rest. Input,
paste, and clipboard are already gated to the single active pane via the
`interactive` prop.

**Implication:** transport, streaming, reconnect, LRU eviction, and per-pane
input gating already exist. Multi-view is a **layout + geometry + refit**
problem, not a new transport. The one genuinely new mechanical requirement is
per-pane refit (below).

## Model — the pane tree

A split is a binary tree with two node kinds:

```ts
type PaneNode = Leaf | Branch;

interface Leaf {
  kind: 'leaf';
  id: string;                 // stable pane id (for focus, keys, drop targets)
  session: SessionRef | null; // null = empty pane → picker
}

interface SessionRef { hostId: string; sessionId: string; }

interface Branch {
  kind: 'branch';
  id: string;
  dir: 'row' | 'col';         // row = side by side, col = stacked
  a: PaneNode;
  b: PaneNode;
  ratio: number;              // 0..1, size of `a` along `dir`; divider position
}
```

Single-focus (today's behaviour) is a tree of exactly one leaf. Everything
generalizes from there, so the empty/one-session case is not a special path.

### Operations (`paneTree.ts`, pure)

- `splitLeaf(tree, targetPaneId, dir, side, session)` — replace the target leaf
  with a branch; the new leaf (holding `session`, or `null` for empty) goes on
  `side` (`'a'|'b'`), the existing leaf on the other. `dir` + `side` cover
  split-right/left/up/down.
- `closePane(tree, paneId)` — remove the leaf; its sibling collapses up into the
  parent's slot. Closing the last leaf yields a single empty leaf.
- `setSession(tree, paneId, session | null)` — fill/replace/clear a leaf (center
  drop, picker choice, prune).
- `setRatio(tree, branchId, ratio)` — divider drag; clamp to a sane min (e.g.
  each side ≥ a few character cells).
- `focusablePanes(tree)` / `findLeaf(tree, paneId)` — traversal helpers.

All ops are immutable (return a new tree), so React state updates and undo are
trivial and the functions are trivially unit-testable.

## Geometry — `layoutRects.ts` (pure)

`layoutRects(tree, width, height): Map<paneId, Rect>` walks the tree and assigns
each leaf an absolute `{ left, top, width, height }`, subtracting a fixed
divider thickness at each branch. Pure function of tree + container size — no
DOM. Unit-tested against known trees.

`ResidentTerminals` computes rects from the current container size (via a single
`ResizeObserver` on `.resident-terminals`) and positions each **in-tree** pane
at its rect (absolute) instead of `inset:0`. Panes **not** in the tree remain
mounted and hidden exactly as today (still cached, still streaming) — so
toggling a session out of a split never drops its socket.

## Per-pane refit (the one new mechanical requirement)

Today every pane is full-screen, so a pane never needed to react to its own box
changing. In a split, a pane is smaller and its size changes on divider drag,
split, close, and window resize. Each **visible** pane must therefore:

1. `fit.fit()` its xterm to the new box, then
2. send a `resize` frame (new cols/rows) to the server for that session.

Implementation: `TerminalPane` gets a `ResizeObserver` on its host element (or a
`geometryVersion` prop bumped by `ResidentTerminals`) that debounces to the next
frame and calls the existing fit+resize path (`fitRef` already exists). Hidden
panes skip refit until shown. This reuses the resize plumbing already bound in
`bindTerminalSession`; nothing new on the wire.

## Focus & input

Exactly one focused pane. `App.activeSessionId` / `activeHostId` track the
**focused pane's** session. Clicking anywhere in a pane focuses it. Only the
focused pane receives `interactive` — keystrokes, paste, and clipboard — reusing
the current gating unchanged. Every other visible pane streams read-only.

The app tint (`--lit` / edge glow) and any session-derived chrome follow the
focused pane's session, exactly as they follow the active session today.

Keyboard shortcuts (bound at the app shell, only when a pane is focused):
- Split right / down (e.g. `Cmd/Ctrl+D`, `Cmd/Ctrl+Shift+D`).
- Move focus between panes (directional, e.g. `Cmd/Ctrl+Alt+Arrow`).
- Close focused pane (e.g. `Cmd/Ctrl+W` — pane close, not session kill).

Exact chords are an implementation detail to confirm against existing bindings;
they must not clobber shortcuts already in use.

## Interaction gestures

### Split buttons
The focused pane shows split-right and split-down affordances (in the pane
toolbar / on hover). Activating one inserts a branch; the new leaf is **empty**
and shows the picker.

### Empty-pane picker
An empty leaf renders a small chooser: list of existing sessions (grouped by
host, reusing tab labels) + a "New session" action (calls `app.newSession`).
Picking sets the leaf's session.

### Right-click a tab → split menu
Context menu on any tab (`SessionTabBar` and `SessionDrawer` rows): "Split
right / left / up / down". Splits the **focused** pane in that direction and
drops **that tab's** session into the new leaf (no picker — the session is
already chosen). If nothing is focused (empty tree), it fills the single pane.

### Drag a tab into a pane, with live preview
Dragging a tab produces a drag payload of its `SessionRef`. While the pointer is
over a pane, `dropZone.ts` maps the pointer's position within the pane rect to a
**drop intent**:

- near the left/right/top/bottom edge → split that pane in that direction, new
  leaf on the near side;
- center → replace the pane's session.

A `SplitPreviewOverlay` renders a translucent ghost of the resulting region
(the half/edge that the new pane will occupy, or a full-pane highlight for
replace) so the user sees the outcome before dropping. On drop, commit the
corresponding `paneTree` op.

`dropZone.ts` is pure (`(pointerX, pointerY, rect) → DropIntent`) and
unit-tested; the DnD wiring is thin glue over it.

### Dividers
`PaneDivider.tsx` sits on each branch boundary; pointer-drag updates
`ratio` via `setRatio` (clamped). Refit fires as panes resize.

## Persistence & liveness — `paneTreeSerialize.ts`

Serialize the tree (pane ids, dirs, ratios, and `sessionKey(hostId, sessionId)`
per leaf) to localStorage, beside the existing `tabLayout` preference. On load:

1. Parse the stored tree.
2. Prune leaves whose session is absent from `GET /api/sessions` (dead/killed).
   A branch left with one live child collapses to that child; a fully dead
   subtree collapses away.
3. If the tree ends up empty, fall back to a single leaf holding the current
   `activeSessionId` (today's behaviour).

Cross-host mix persists naturally — leaves key on the host-qualified
`sessionKey`. Serialization round-trip and dead-prune are unit-tested.

## Interaction with existing tab chrome

Splitting is **orthogonal** to the sidebar-vs-horizontal tab layout
(`preferences.ts` `TabLayout`). The pane tree owns only the `.screen` interior;
the drawer and tab strip are unchanged and remain the way you reach sessions not
currently in a pane. Both build gestures work from either chrome.

## Modules & files

**New (each with a colocated `.test.ts` where it holds logic):**
- `paneTree.ts` — tree type + split/close/setSession/setRatio ops.
- `layoutRects.ts` — tree + size → per-pane rects.
- `dropZone.ts` — pointer position in a pane → drop intent.
- `paneTreeSerialize.ts` — (de)serialize + prune-dead.
- `SplitPreviewOverlay.tsx` — ghost preview during drag.
- `PaneDivider.tsx` — draggable divider.
- Empty-pane picker + tab context menu components.

**Touched:**
- `ResidentTerminals.tsx` — position in-tree panes by rect; `ResizeObserver`;
  render dividers, preview overlay, empty-pane pickers.
- `TerminalPane.tsx` — per-pane refit on geometry change.
- `App.tsx` — own the pane tree state; focus tracking; keyboard shortcuts;
  wire `activeSessionId` to focused pane.
- `SessionTabBar.tsx` / `SessionDrawer.tsx` — draggable tabs + right-click menu.
- `preferences.ts` — persist/load the pane tree.
- `index.css` — split/divider/preview/picker styles; relax the
  `.resident-pane` absolute-`inset:0` rule to rect-driven positioning.

## Testing

Pure logic covered without a PTY (bun:test, colocated):
- `paneTree.test.ts` — split in each direction, close+collapse, replace, ratio
  clamp, single-leaf edge cases.
- `layoutRects.test.ts` — rects sum to container minus dividers; nested trees.
- `dropZone.test.ts` — each edge band + center → correct intent; boundaries.
- `paneTreeSerialize.test.ts` — round-trip; prune dead leaves + collapse; empty
  → fallback.

React glue (positioning, DnD, dividers, menus) stays thin over the tested pure
modules. Desktop suite: `bun --cwd apps/desktop run test`.

## Out of scope (YAGNI)

- Broadcast/synchronized input across panes (explicitly deferred — chosen "one
  focused pane").
- Saved named layouts / multiple layout presets.
- Detaching a pane into a separate OS window.
- Any iOS or server change.

## Risks / watch-items

- **Refit correctness** is the sharpest edge: a pane that fails to refit shows a
  server grid that mismatches its box. Cover the fit+resize path deliberately in
  manual testing.
- **Shortcut collisions** with existing desktop/webview bindings — audit before
  binding.
- Many simultaneously visible xterm instances each hold a WebGL context; if the
  browser hits its WebGL-context cap the existing software-renderer fallback in
  `mountTerminal` covers it, but keep an eye on it at high pane counts.
