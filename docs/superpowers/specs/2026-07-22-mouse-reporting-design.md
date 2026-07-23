# Mouse click/drag reporting to PTY — design

**Board:** #247 (high). **Date:** 2026-07-22.

## Problem

The emulator tracks that an app enabled mouse reporting (`mouseOn`) and negotiated
SGR encoding (`mouseSgr`), but `mouseSeq.ts` is only wired for **wheel-scroll**
forwarding. Tap-to-position and drag-select are never sent to the PTY, so vim
mouse mode, tmux pane clicks, and htop/mc row clicks are dead — most painfully on
mobile, where there is no other pointer.

This design wires real click and drag reporting on **both** mobile (touch
gestures) and desktop (real mouse), sharing one encoder and one cell-math helper.

## Protocol reference (verified)

Sources: xterm control sequences (invisible-island ctlseqs) and xterm.js.

- **Cb (button byte):** low 2 bits = button (0 left, 1 middle, 2 right);
  release = 3 in X10/normal. Modifiers OR-ed in: `+4` shift, `+8` meta, `+16`
  control. `+32` = motion. `+64` = wheel (button 4/5 → 64/65).
- **DECSET modes:** 9 = X10 (press only), 1000 = normal (press + release),
  1002 = button-event (adds motion **while a button is down**, per changed cell),
  1003 = any-event (motion always). 1006 = SGR extended encoding.
- **X10/legacy encoding:** `CSI M Cb Cx Cy`, each byte offset by `+32`, one byte
  per field (classic ≤223 limit; we clamp to 127 for UTF-8 safety, per the
  existing comment in `mouseSeq.ts`).
- **SGR (1006) encoding:** `CSI < Cb ; Cx ; Cy M` for press/motion, final `m` for
  release. Cb and coords are **not** offset; the real button survives on release.
  1-based coordinates, no column limit.

## Decisions

- **Scope:** mobile + desktop (shared encoder + emulator mode state).
- **Mobile gesture model (auto):** when mouse reporting is on, tap = click,
  1-finger pan = drag, 2-finger vertical pan = wheel scroll, long-press = the
  existing app selection overlay. Keyboard is summoned from the key bar, not by
  tapping. When mouse reporting is off, behaviour is unchanged (tap focuses the
  keyboard).
- **Desktop:** real `mousedown`/`mousemove`/`mouseup` → press/motion/release.
  **Shift held bypasses reporting** so native text selection still works (xterm.js
  convention).
- **User kill switch:** a persisted **Mouse control** toggle (default on) lets the
  user disable all mouse forwarding even while an app has reporting enabled — so
  they can fall back to native scroll/tap/select on demand. Shift-bypass on
  desktop is the per-gesture escape hatch; this toggle is the global one.
- **Out of scope (YAGNI):** hilite tracking (1001), pixel mode (1016), UTF-8
  mouse (1005), urxvt (1015). Left unimplemented; modes just stay `off`.

## Components

### 1. Emulator mode state — `apps/mobile/src/terminal.ts`

Replace the single `mouseOn` boolean with mode granularity (the encoder and UI
need press-only vs drag vs any-motion):

```ts
mouseMode: 'off' | 'x10' | 'normal' | 'button' | 'any' = 'off';
mouseSgr = false; // unchanged (DECSET 1006)
get mouseOn() { return this.mouseMode !== 'off'; }
```

- `setMode` (terminal.ts ~739): `9→'x10'`, `1000→'normal'`, `1002→'button'`,
  `1003→'any'`; disabling any of them → `'off'`. `1006` still toggles `mouseSgr`.
- `reset()` clears `mouseMode='off'`, `mouseSgr=false`.
- The `mouseOn` getter keeps every existing call site working unchanged
  (`scrollEnabled` gate, both wheel forwarders, the `mouseOnRef` mirror).

### 2. Encoder — `apps/mobile/src/mouseSeq.ts`

Extend, do not rewrite. Existing wheel callers pass no options and keep today's
behaviour.

```ts
export function mouseSeq(
  btn: number, col: number, row: number, sgr: boolean,
  opts?: { release?: boolean; motion?: boolean },
): string
```

- `motion` → OR `+32` into Cb.
- SGR: press/motion final `M`; `release` → final `m`, real button preserved.
- X10/legacy: `release` → button bits set to 3 (`Cb = 3 | modifiers | motionBit`);
  coords clamped ≤127 as today.
- Wheel path (`btn` 64/65, no opts) is byte-for-byte unchanged.

### 3. Shared gesture→event helper — `apps/mobile/src/mouseInput.ts` (new)

Pure, platform-agnostic, unit-tested:

- `cellFromPoint(x, y, rect, cols, rows)` → clamped 1-based `{col,row}`
  (extracted from the existing desktop wheel math at useTetherApp ~1467 so both
  paths share it).
- `clickSeqs(col, row, mode, sgr, mods?)` → `[press, release]`; release omitted
  when `mode === 'x10'`.
- `dragSeqs` builders: `press`, `motion` (emitted only when `mode ∈ {button,any}`
  and the cell changed since the last motion), `release`.

Button = 0 (left) for touch; desktop passes the real button + modifier bits.

### 4. Mobile wiring — `useTetherApp.tsx` PanResponder + `TerminalScreen.tsx` Pressable

When `mouseOn`:

- **tap** (`Pressable onPress`, `!scrolledRef.current`) → send `clickSeqs` at the
  tapped cell **instead of** focusing the input. (Keyboard comes from the key-bar
  button.)
- **1-finger pan** → grant: press at start cell; move: motion seq when the cell
  changes (button/any modes only); release on end.
- **2-finger pan** (`gestureState.numberActiveTouches === 2`, vertical) → the
  existing wheel 64/65 path.
- **long-press** → selection overlay (unchanged).

PanResponder claim predicates updated to route by active touch count. When
`mouseOn === false`, all gestures behave exactly as today.

Cell of a touch is derived via `cellFromPoint` using the terminal surface layout
(same rect approach as desktop), not font metrics.

### 5. Desktop wiring — `useTetherApp.tsx` window listeners

Alongside the existing `onWheel` effect, add `mousedown`/`mousemove`/`mouseup`
listeners scoped to `#tether-terminal`, active only when `mouseOn`:

- **down** → press: button from `e.button` (0/1/2), modifiers from
  `shiftKey/altKey/ctrlKey`, cell from `cellFromPoint`.
- **move** → motion seq when the cell changes (button/any modes); throttled to
  cell granularity (ignore intra-cell moves).
- **up** → release.
- **Shift held on down → skip reporting entirely** so native selection passes
  through.

### 6. User kill switch — `OverflowMenu` + `useTetherApp.tsx`

- `mouseEnabled: boolean` user preference, default `true`, persisted with the same
  mechanism as `fontSize` (AsyncStorage / secure config), so it survives restarts.
- **Mouse control** toggle added to the overflow (`⋯`) menu, near Font size.
- The UI's effective gate becomes `mouseActive = term.mouseOn && mouseEnabled`.
  Every new forwarding path (mobile tap/pan, desktop mouse listeners) checks
  `mouseActive`, not raw `mouseOn`. When `mouseEnabled` is false, gestures behave
  exactly as when the app never enabled reporting (tap = keyboard, swipe = native
  scroll), and the desktop mouse listeners are detached.
- The emulator still tracks `mouseMode` while disabled, so toggling back on
  resumes reporting live with no reconnect.
- `scrollEnabled` on the list uses `!mouseActive` (was `!mouseOn`) so disabling
  mouse control restores native scrolling immediately.

## Data flow

```
gesture / mouse event
  → cellFromPoint → {col,row}
  → clickSeqs | dragSeqs (mode + sgr aware)
  → wsSend({type:'input', text})
  → server → holder → PTY
```

Identical to the existing wheel path; only the sequence builder and the event
sources are new.

## Error handling / edge cases

- Mode `off` → no reporting; gestures fall back to today's behaviour.
- `x10` → press only, no release, no motion.
- `normal` → press + release, no motion (a drag reports only its endpoints’
  press/release, never intermediate motion).
- Motion deduped per cell so a slow drag across one cell emits at most one motion
  report per new cell.
- SGR off (legacy) on a grid wider than 95 columns: coordinates clamp (documented
  limitation, already noted in `mouseSeq.ts`); rare because apps that enable mouse
  almost always enable 1006.

## Testing

- `mouseSeq.test.ts` (extend): release final `m` (SGR) and button-3 (X10); motion
  `+32`; wheel path unchanged.
- `mouseInput.test.ts` (new): `cellFromPoint` clamping; `clickSeqs` omits release
  in x10; `dragSeqs` motion gated to button/any and deduped per cell.
- `terminal.parser.test.ts` (extend): DECSET 9/1000/1002/1003/1006 set the right
  `mouseMode`/`mouseSgr`; disabling resets to `off`; `mouseOn` getter tracks it.
- Kill switch: `mouseActive` is false when `mouseEnabled` is false regardless of
  `mouseOn`; toggling `mouseEnabled` back on with a live `mouseMode` re-enables
  forwarding (asserted at the gate/helper level, not via UI).

## Non-goals

- #298 (server typecheck baseline) is already green (`bun run --cwd apps/server
  typecheck` exits 0) — dropped as stale, closed on the board, not touched here.
- No new UI chrome beyond routing existing gestures; no settings toggle.
