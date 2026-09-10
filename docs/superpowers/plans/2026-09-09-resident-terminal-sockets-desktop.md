# Resident Terminal Sockets — Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Tauri desktop client, switching terminal tabs while the app is open causes zero replay — non-visible sessions keep a live socket and stream in the background, up to an LRU cap.

**Architecture:** Flip `ResidentTerminals` from rendering one `TerminalPane` per visible pane leaf to rendering one per *resident session* (keyed by `sessionKey`), positioned into its pane rect when shown and parked offscreen when not. Two pure modules decide the resident set (`sessionLru`, `residentSessions`); the React component maps that set to positioned panes. Keying by session means a tab switch re-positions an existing mounted instance instead of remounting it, so the socket and xterm scrollback survive.

**Tech Stack:** Bun + TypeScript, React 18, `@xterm/xterm`, Tauri 2. Tests are `bun:test`, pure-logic only (no DOM/React harness in this workspace).

**Spec:** `docs/superpowers/specs/2026-09-09-resident-terminal-sockets-design.md`

## Global Constraints

- Base this branch on `fix/terminal-replay-cursor-persistence` (PR #172) or on `main` after #172 merges — this work depends on `reconcileResidency` and the persisted cursor. Do not duplicate those.
- Resident cap: **8**. Visible panes always count and are never evicted.
- Host scope: all connected hosts.
- Only terminal (non-agent) sessions get background residency. Agent panes (`AgentChatPane`) keep current behavior (rendered only when visible).
- Input, focus, paste, clipboard remain gated to the active tab (existing gate, unchanged).
- Formatting: Biome (2-space, single quotes, semicolons, trailing commas, width 100). Run `bun format` before committing.
- Tests colocated: `foo.ts` + `foo.test.ts`. Use `bun run test` in `apps/desktop`, never bare `bun test`.

---

### Task 1: `sessionLru` — recency order of active sessions

**Files:**
- Create: `apps/desktop/src/sessionLru.ts`
- Test: `apps/desktop/src/sessionLru.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `touchLru(order: string[], key: string, max?: number): string[]` — returns a new array with `key` moved to the front, de-duplicated, truncated to `max` (default 64). Most-recently-active first.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { touchLru } from './sessionLru';

describe('touchLru', () => {
  test('moves a touched key to the front', () => {
    expect(touchLru(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  test('de-duplicates — a re-touched key is not repeated', () => {
    expect(touchLru(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });

  test('adds a new key at the front', () => {
    expect(touchLru(['a'], 'b')).toEqual(['b', 'a']);
  });

  test('truncates to max, dropping the least-recent', () => {
    expect(touchLru(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });

  test('does not mutate the input', () => {
    const input = ['a', 'b'];
    touchLru(input, 'c');
    expect(input).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/sessionLru.test.ts`
Expected: FAIL — `Cannot find module './sessionLru'`.

- [ ] **Step 3: Write minimal implementation**

```ts
/** Most-recently-active session keys, front = newest. Drives which non-visible
 * sessions stay resident. Bounded so the history can't grow without limit. */
export function touchLru(order: string[], key: string, max = 64): string[] {
  return [key, ...order.filter((k) => k !== key)].slice(0, max);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bun test src/sessionLru.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/sessionLru.ts apps/desktop/src/sessionLru.test.ts
git commit -m "feat(desktop): sessionLru recency helper for terminal residency"
```

---

### Task 2: `residentSessions` — decide which sessions stay live

**Files:**
- Create: `apps/desktop/src/residentSessions.ts`
- Test: `apps/desktop/src/residentSessions.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  ```ts
  export interface ResidentInput {
    drawerKeys: string[];   // every live terminal drawer session key, all connected hosts
    visibleKeys: string[];  // sessions currently placed in a pane — always resident
    lruOrder: string[];     // touchLru output, most-recent first
    cap: number;            // resident ceiling (8)
  }
  export function residentSessions(input: ResidentInput): string[]
  ```
  Returns the ordered set of session keys that get a mounted `TerminalPane`: all `visibleKeys` (even if they exceed `cap` — visible is never evicted), then filled from `lruOrder` (restricted to `drawerKeys`, excluding ones already visible) until length reaches `cap`. Every returned key is present in `drawerKeys`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { residentSessions } from './residentSessions';

describe('residentSessions', () => {
  test('visible sessions are always resident', () => {
    const out = residentSessions({
      drawerKeys: ['h:a', 'h:b'],
      visibleKeys: ['h:a'],
      lruOrder: [],
      cap: 8,
    });
    expect(out).toContain('h:a');
  });

  test('fills remaining capacity from the LRU, most-recent first', () => {
    const out = residentSessions({
      drawerKeys: ['h:a', 'h:b', 'h:c', 'h:d'],
      visibleKeys: ['h:a'],
      lruOrder: ['h:c', 'h:b'],
      cap: 3,
    });
    // visible h:a, then h:c and h:b from the LRU, capped at 3.
    expect(out).toEqual(['h:a', 'h:c', 'h:b']);
  });

  test('never exceeds the cap when filling from the LRU', () => {
    const out = residentSessions({
      drawerKeys: ['h:a', 'h:b', 'h:c'],
      visibleKeys: [],
      lruOrder: ['h:a', 'h:b', 'h:c'],
      cap: 2,
    });
    expect(out).toHaveLength(2);
  });

  test('visible sessions past the cap are all kept (never evicted)', () => {
    const out = residentSessions({
      drawerKeys: ['h:a', 'h:b', 'h:c'],
      visibleKeys: ['h:a', 'h:b', 'h:c'],
      lruOrder: [],
      cap: 2,
    });
    expect(out).toEqual(['h:a', 'h:b', 'h:c']);
  });

  test('a key absent from the drawer is never resident', () => {
    const out = residentSessions({
      drawerKeys: ['h:a'],
      visibleKeys: [],
      lruOrder: ['h:ghost', 'h:a'],
      cap: 8,
    });
    expect(out).not.toContain('h:ghost');
    expect(out).toContain('h:a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/residentSessions.test.ts`
Expected: FAIL — `Cannot find module './residentSessions'`.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface ResidentInput {
  drawerKeys: string[];
  visibleKeys: string[];
  lruOrder: string[];
  cap: number;
}

/** The session keys that keep a live socket. Visible panes are unconditional;
 * the rest of the budget is filled from the recency order, most-recent first.
 * Everything returned is a current drawer session. */
export function residentSessions(input: ResidentInput): string[] {
  const drawer = new Set(input.drawerKeys);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of input.visibleKeys) {
    if (drawer.has(key) && !seen.has(key)) {
      out.push(key);
      seen.add(key);
    }
  }
  for (const key of input.lruOrder) {
    if (out.length >= input.cap) break;
    if (drawer.has(key) && !seen.has(key)) {
      out.push(key);
      seen.add(key);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bun test src/residentSessions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/residentSessions.ts apps/desktop/src/residentSessions.test.ts
git commit -m "feat(desktop): residentSessions selector (visible + LRU, capped)"
```

---

### Task 3: Track recency in App state

**Files:**
- Modify: `apps/desktop/src/App.tsx` (the component that renders `<ResidentTerminals>` and owns `focusedPaneId` + `activeView`)
- Test: none (wiring; covered by Task 1/2 pure tests and the Task 4 render).

**Interfaces:**
- Consumes: `touchLru` (Task 1), `sessionKey` (existing `./sessionKey`), `residentKeys` (existing `./residentKeys`).
- Produces: an `lruOrder: string[]` value passed into `<ResidentTerminals lruOrder={...}>` (prop added in Task 4).

- [ ] **Step 1: Add the recency state and bump it when the focused session changes**

In `App.tsx`, add near the other `useState`/`useMemo` hooks (after `focusedPaneId` is derived, around line 180):

```tsx
const [lruOrder, setLruOrder] = useState<string[]>([]);

// The focused pane's session is the most-recently-active. Bump it into the
// recency order so residentSessions keeps it (and its recent neighbours) live.
const focusedSessionKey = useMemo(() => {
  const leaf = findLeaf(tree, focusedPaneId);
  return leaf?.session ? sessionKey(leaf.session.hostId, leaf.session.sessionId) : null;
}, [tree, focusedPaneId]);

useEffect(() => {
  if (focusedSessionKey) setLruOrder((order) => touchLru(order, focusedSessionKey));
}, [focusedSessionKey]);
```

Add the imports at the top of `App.tsx`:

```tsx
import { touchLru } from './sessionLru';
import { sessionKey } from './sessionKey';
```

(`findLeaf` is already imported in `App.tsx`; if not, add it from `./paneTree`.)

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: no errors. (`lruOrder` is unused until Task 4 wires the prop; TypeScript allows an unused local `const`. If a lint rule flags it, proceed to Task 4 in the same commit.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(desktop): track session recency order in App"
```

---

### Task 4: Render one `TerminalPane` per resident session, positioned by layout

**Files:**
- Modify: `apps/desktop/src/ResidentTerminals.tsx`
- Modify: `apps/desktop/src/App.tsx` (pass the new `lruOrder` prop)
- Test: none new (pure selection is tested in Tasks 1–2; this is the render wiring).

**Interfaces:**
- Consumes: `residentSessions` (Task 2), `sessionKey`/`parseSessionKey` (existing), `residentKeys` (existing), `reconcileResidency` (from PR #172), `layoutTree` (existing).
- Produces: `<ResidentTerminals lruOrder={string[]}>` prop.

The current component maps `layout.leaves` to panes. The new model builds a
positioned entry for **every resident session key**, using the layout only to
find a rect (and interactivity) for the ones currently shown. Sessions not in
the layout are positioned offscreen.

- [ ] **Step 1: Add the `lruOrder` prop and a resident-positioning helper**

At the top of `ResidentTerminals.tsx`, add to `ResidentTerminalsProps`:

```tsx
  /** Most-recently-active session keys (front = newest) for background residency. */
  lruOrder: string[];
```

Add imports:

```tsx
import { parseSessionKey, sessionKey } from './sessionKey';
import { residentSessions } from './residentSessions';
```

Add this constant near the top of the file (module scope):

```tsx
const RESIDENT_CAP = 8;
/** Where a non-visible resident pane parks: real size, far offscreen, inert. */
const OFFSCREEN_STYLE = {
  position: 'absolute' as const,
  left: -100000,
  top: 0,
  width: 800,
  height: 600,
  visibility: 'hidden' as const,
  pointerEvents: 'none' as const,
};
```

- [ ] **Step 2: Replace the render body to key panes by session**

Replace the `return (...)` block's `{layout.leaves.map(...)}` section. Keep the
empty-pane and divider/preview rendering as-is; add a resident-terminal layer.
The full new `return` is:

```tsx
  const visibleBySession = new Map<string, { rect: Box; paneId: string }>();
  for (const leaf of layout.leaves) {
    if (leaf.session) {
      visibleBySession.set(
        sessionKey(leaf.session.hostId, leaf.session.sessionId),
        { rect: leaf.rect, paneId: leaf.paneId },
      );
    }
  }

  const terminalDrawerKeys = props.sessions
    .filter((row) => row.kind !== 'agent')
    .map((row) => sessionKey(row.hostId, row.id));

  const resident = residentSessions({
    drawerKeys: terminalDrawerKeys,
    visibleKeys: [...visibleBySession.keys()],
    lruOrder: props.lruOrder,
    cap: RESIDENT_CAP,
  });

  return (
    <div className="resident-terminals" ref={containerRef}>
      {/* Visible pane chrome: empty pickers, agent panes, focus ring, controls. */}
      {layout.leaves.map((leaf) => {
        const style = {
          position: 'absolute' as const,
          left: leaf.rect.left,
          top: leaf.rect.top,
          width: leaf.rect.width,
          height: leaf.rect.height,
        };
        if (!leaf.session) {
          return (
            <div
              key={leaf.paneId}
              className="pane-slot"
              style={style}
              data-pane-id={leaf.paneId}
              data-pane-empty="1"
            >
              <EmptyPanePicker onPick={() => props.onPickSession(leaf.paneId)} />
            </div>
          );
        }
        const session = leaf.session;
        const host = props.hosts.find((row) => row.id === session.hostId);
        if (!host) return null;
        const drawer = props.sessions.find(
          (row) => row.hostId === session.hostId && row.id === session.sessionId,
        );
        const isAgent = session.kind === 'agent' || drawer?.kind === 'agent';
        return (
          <div
            key={leaf.paneId}
            className={`pane-slot${leaf.paneId === props.focusedPaneId ? ' focused' : ''}`}
            style={style}
            data-pane-id={leaf.paneId}
            onPointerDownCapture={() => props.onFocusPane(leaf.paneId)}
          >
            {leaf.paneId === props.focusedPaneId && (
              <PaneControls
                paneId={leaf.paneId}
                onSplit={props.onSplit}
                onClose={props.onClosePane}
              />
            )}
            {isAgent ? (
              <AgentChatPane
                hostId={session.hostId}
                sessionId={session.sessionId}
                noiseAddress={noiseSessionAddress(host)}
                cwd={session.cwd ?? drawer?.cwd ?? undefined}
              />
            ) : null}
          </div>
        );
      })}

      {/* Resident terminals: one instance per resident session, keyed by session
          so a tab switch re-positions rather than remounts. Positioned into the
          pane rect when shown, parked offscreen when only kept live. */}
      {resident.map((key) => {
        const { hostId, sessionId } = parseSessionKey(key);
        const host = props.hosts.find((row) => row.id === hostId);
        if (!host) return null;
        const shown = visibleBySession.get(key);
        const style = shown
          ? {
              position: 'absolute' as const,
              left: shown.rect.left,
              top: shown.rect.top,
              width: shown.rect.width,
              height: shown.rect.height,
            }
          : OFFSCREEN_STYLE;
        return (
          <div key={key} className="resident-terminal-holder" style={style}>
            <TerminalPane
              hostId={hostId}
              sessionId={sessionId}
              interactive={!!shown && shown.paneId === props.focusedPaneId}
              noiseAddress={noiseSessionAddress(host)}
              terminalTheme={props.terminalTheme}
              fontFamily={props.fontFamily}
              fontSize={props.fontSize}
              onFrame={props.onFrame}
              onDisconnected={() => props.onDisconnected(hostId)}
            />
          </div>
        );
      })}

      {layout.dividers.map((divider) => (
        <PaneDivider
          key={divider.branchId}
          divider={divider}
          containerOrigin={{ left: box.left, top: box.top }}
          onRatio={(ratio) => props.onSetRatio(divider.branchId, ratio)}
        />
      ))}
      {previewRect && props.preview && (
        <SplitPreviewOverlay rect={previewRect} intent={props.preview.intent} />
      )}
    </div>
  );
```

Note: the terminal `TerminalPane` is now rendered in the resident layer, so it
was removed from the `layout.leaves` branch above (that branch now renders only
empty pickers and agent panes). The focus ring / `PaneControls` stay on the
per-leaf chrome div, which sits under the resident terminal at the same rect.

- [ ] **Step 3: Keep the cursor-forget reconcile driven by the resident set**

The existing `reconcileResidency` effect (from PR #172) still runs and is
correct: it forgets cursors only for sessions gone from the drawer. Leave it.
Update its `wantedKeys` to the resident set so a session evicted from residency
(but still in the drawer) keeps its cursor for delta-replay. Change the effect
body's `wantedKeys` source from `residentKeys(props.tree)` to the resident set —
compute `resident` once above the `return` (already done in Step 2) and reference
it. Since the effect and the render both need `resident`, hoist the `resident`
computation into a `useMemo` above the effect:

```tsx
const resident = useMemo(
  () =>
    residentSessions({
      drawerKeys: props.sessions
        .filter((row) => row.kind !== 'agent')
        .map((row) => sessionKey(row.hostId, row.id)),
      visibleKeys: residentKeys(props.tree),
      lruOrder: props.lruOrder,
      cap: RESIDENT_CAP,
    }),
  [props.sessions, props.tree, props.lruOrder],
);
```

Then in the reconcile effect, pass `wantedKeys: resident` to `reconcileResidency`
and add `resident` to the effect deps. Remove the now-duplicated inline `resident`
from Step 2's render prologue (use this memoized one; still build
`visibleBySession` in the render).

- [ ] **Step 4: Pass the prop from App**

In `App.tsx`, at the `<ResidentTerminals ... />` usage (around line 600), add:

```tsx
                  lruOrder={lruOrder}
```

- [ ] **Step 5: Typecheck, lint, test, build**

Run:
```bash
cd apps/desktop
bunx tsc --noEmit
bunx biome check src/ResidentTerminals.tsx src/App.tsx src/residentSessions.ts src/sessionLru.ts
bun run test
bun run build
```
Expected: tsc clean; biome clean; all tests pass (251 prior + 10 new); vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/ResidentTerminals.tsx apps/desktop/src/App.tsx
git commit -m "feat(desktop): resident terminal sockets — key panes by session, park offscreen"
```

---

### Task 5: Manual verification of the zero-replay oracle

**Files:** none (runtime check).

The unit tests prove the selection logic; this task proves the runtime behavior
the spec asks for. Desktop can be driven headless on `:1` (see repo memory).

- [ ] **Step 1: Launch the desktop client against a live host**

Run: `cd apps/desktop && bun run tauri:dev` (or the headless `:1` recipe). Pair a
host with at least two terminal sessions.

- [ ] **Step 2: Reproduce A→B→A**

In session A, run a marker: `echo RESIDENT_MARKER_A`. Switch the pane to session
B, then back to A.

- [ ] **Step 3: Assert no replay**

Expected: on returning to A, its screen shows the *live* tail with no visible
re-scroll of `RESIDENT_MARKER_A`, and the network shows **no** new Noise `start`
frame for A (the socket stayed open). Confirm via the dev console / a `console.log`
in `openSocket` (`terminalBind.ts`) that it is not called on switch-back.

- [ ] **Step 4: Assert eviction is graceful**

Open 9+ terminal sessions, cycle through them, return to the oldest. Expected: the
oldest (evicted past cap 8) reconnects and replays only the delta (persisted
cursor), not the full tail.

- [ ] **Step 5: Record the result**

Add a board note to #1149 (or a new task) with the observed behavior.

---

## Self-Review

**Spec coverage:**
- Resident cap 8 / visible-always / all hosts → Task 2 (`residentSessions`), `RESIDENT_CAP`. ✓
- Key by session, position offscreen when hidden → Task 4. ✓
- Beyond cap → persistence+delta (cursor kept via `reconcileResidency` `wantedKeys=resident`) → Task 4 Step 3. ✓
- Input/focus/paste gated to active → `interactive` prop unchanged. ✓
- Agent panes excluded → `row.kind !== 'agent'` filter. ✓
- Zero-replay oracle → Task 5. ✓

**Placeholder scan:** none — all steps carry real code/commands.

**Type consistency:** `touchLru(order, key, max?)`, `residentSessions({drawerKeys, visibleKeys, lruOrder, cap})`, `sessionKey(hostId, sessionId)`, `parseSessionKey(key) → {hostId, sessionId}` used consistently across Tasks 1–4. `RESIDENT_CAP = 8` single source. ✓
