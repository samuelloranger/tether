# Mouse click/drag reporting to PTY — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward real mouse click and drag events to the PTY from both mobile (touch gestures) and desktop (real mouse), so vim/tmux/htop mouse modes work — with a user kill switch.

**Architecture:** The emulator gains mouse-*mode* granularity (off/x10/normal/button/any) replacing a single bool. A pure encoder (`mouseSeq`) is extended for release/motion, and a new pure helper (`mouseInput.ts`) turns coordinates + mode into byte sequences. Mobile and desktop UI both call the shared helper through one gate, `mouseActive = mouseOn && mouseEnabled`.

**Tech Stack:** Expo React Native 57 / RN 0.86 / React 19, TypeScript, Bun test runner, Biome. Desktop is the same code under Tauri (react-native-web).

## Global Constraints

- Runtime: Expo 57 / RN 0.86 / React 19 — before writing Expo code, consult https://docs.expo.dev/versions/v57.0.0/ (per `apps/mobile/AGENTS.md`).
- Formatting: Biome — 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before committing.
- Tests: `bun test` from `apps/mobile`. No new deps.
- Mouse protocol (verified vs xterm ctlseqs + xterm.js): Cb = button(0/1/2) | +4 shift | +8 meta | +16 ctrl | +32 motion | +64 wheel. Release = button 3 in X10/normal; SGR keeps the real button with final `m`. X10 offsets Cb/Cx/Cy by +32, clamped ≤127. SGR: `CSI < Cb ; Cx ; Cy M` press / `m` release, no offset, 1-based coords.
- Branch: `feat/mouse-reporting` (already exists, spec already committed on it).
- Wheel forwarding must stay byte-for-byte unchanged (existing `mouseSeq.test.ts` cases must still pass).

---

### Task 1: Emulator mouse-mode granularity

Replace the single `mouseOn` boolean with a `mouseMode` enum + a derived `mouseOn` getter, so callers are untouched but the encoder/UI can tell press-only vs drag vs any-motion apart.

**Files:**
- Modify: `apps/mobile/src/terminal.ts` (field decl ~220, `reset()` ~299, `setMode()` ~739)
- Test: `apps/mobile/src/terminal.parser.test.ts`

**Interfaces:**
- Produces: `type MouseMode = 'off' | 'x10' | 'normal' | 'button' | 'any'` (exported from `terminal.ts`); `TerminalEmulator.mouseMode: MouseMode`; `get mouseOn(): boolean`; `mouseSgr: boolean` (unchanged).

- [ ] **Step 1: Write the failing tests**

Add to `apps/mobile/src/terminal.parser.test.ts` (import `TerminalEmulator` is already used in this file; follow its existing feed/write pattern — check the top of the file for the helper used to push bytes, typically `t.write(...)`):

```ts
describe('mouse mode tracking (DECSET 9/1000/1002/1003/1006)', () => {
  const mk = () => new TerminalEmulator(80, 24);
  it('maps each DECSET mode to the right mouseMode', () => {
    let t = mk(); t.write('\x1b[?9h'); expect(t.mouseMode).toBe('x10');
    t = mk(); t.write('\x1b[?1000h'); expect(t.mouseMode).toBe('normal');
    t = mk(); t.write('\x1b[?1002h'); expect(t.mouseMode).toBe('button');
    t = mk(); t.write('\x1b[?1003h'); expect(t.mouseMode).toBe('any');
  });
  it('mouseOn getter tracks mouseMode', () => {
    const t = mk();
    expect(t.mouseOn).toBe(false);
    t.write('\x1b[?1000h'); expect(t.mouseOn).toBe(true);
    t.write('\x1b[?1000l'); expect(t.mouseMode).toBe('off'); expect(t.mouseOn).toBe(false);
  });
  it('tracks SGR encoding independently', () => {
    const t = mk();
    t.write('\x1b[?1006h'); expect(t.mouseSgr).toBe(true);
    t.write('\x1b[?1006l'); expect(t.mouseSgr).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && bun test src/terminal.parser.test.ts -t "mouse mode tracking"`
Expected: FAIL — `mouseMode` is undefined / not a property.

- [ ] **Step 3: Implement mouseMode + getter**

In `apps/mobile/src/terminal.ts`, near the top-level type exports (where other exported types/consts live), add:

```ts
export type MouseMode = 'off' | 'x10' | 'normal' | 'button' | 'any';
```

Replace the `mouseOn = false;` field (~220) and its comment with:

```ts
  // Which mouse-reporting mode the app negotiated (DECSET 9/1000/1002/1003).
  // 'off' ⇒ no reporting. Lets the UI decide press-only vs drag vs any-motion.
  mouseMode: MouseMode = 'off';

  // True when reporting is active in any mode. Kept as a getter so existing
  // call sites (scroll gate, wheel forwarders) read it unchanged.
  get mouseOn(): boolean {
    return this.mouseMode !== 'off';
  }
```

In `reset()` (~299) replace `this.mouseOn = false;` with:

```ts
    this.mouseMode = 'off';
```

In `setMode()` (~739) replace the `m === 1000 || m === 1002 || m === 1003` branch with:

```ts
      } else if (m === 9) {
        this.mouseMode = on ? 'x10' : 'off';
      } else if (m === 1000) {
        this.mouseMode = on ? 'normal' : 'off';
      } else if (m === 1002) {
        this.mouseMode = on ? 'button' : 'off';
      } else if (m === 1003) {
        this.mouseMode = on ? 'any' : 'off';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && bun test src/terminal.parser.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (getter replacing a field compiles because nothing writes `mouseOn` externally).

- [ ] **Step 5: Commit**

```bash
cd apps/mobile && bun format
git add apps/mobile/src/terminal.ts apps/mobile/src/terminal.parser.test.ts
git commit -m "feat(terminal): track mouse reporting mode granularity"
```

---

### Task 2: Extend the encoder for release + motion

Add optional `{release, motion}` to `mouseSeq` without changing the wheel call signature.

**Files:**
- Modify: `apps/mobile/src/mouseSeq.ts`
- Test: `apps/mobile/src/mouseSeq.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mouseSeq(btn: number, col: number, row: number, sgr: boolean, opts?: { release?: boolean; motion?: boolean }): string`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/mouseSeq.test.ts`:

```ts
describe('mouseSeq — press/release/motion', () => {
  it('SGR release uses final m and keeps the real button', () => {
    expect(mouseSeq(0, 5, 3, true, { release: true })).toBe('\x1b[<0;5;3m');
  });
  it('SGR motion ORs +32 into the button, final M', () => {
    expect(mouseSeq(0, 5, 3, true, { motion: true })).toBe('\x1b[<32;5;3M');
  });
  it('X10 release sets the low two button bits to 3', () => {
    // Cb 3 -> 35 '#', col/row 1 -> 33 '!'
    expect(mouseSeq(0, 1, 1, false, { release: true })).toBe('\x1b[M#!!');
  });
  it('X10 motion ORs +32 into Cb', () => {
    // Cb 0+32=32 -> 64 '@'
    expect(mouseSeq(0, 1, 1, false, { motion: true })).toBe('\x1b[M@!!');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && bun test src/mouseSeq.test.ts -t "press/release/motion"`
Expected: FAIL — opts ignored, wrong final char / Cb.

- [ ] **Step 3: Implement**

Replace the body of `apps/mobile/src/mouseSeq.ts`'s `mouseSeq` (keep the file's leading comment) with:

```ts
export function mouseSeq(
  btn: number,
  col: number,
  row: number,
  sgr: boolean,
  opts?: { release?: boolean; motion?: boolean },
): string {
  const motion = opts?.motion ? 32 : 0;
  if (sgr) {
    // SGR: decimal params, real button preserved; press/motion 'M', release 'm'.
    const cb = btn + motion;
    return `\x1b[<${cb};${col};${row}${opts?.release ? 'm' : 'M'}`;
  }
  // Legacy X10: release sets the low two button bits to 3 (button is unknowable
  // in legacy), preserving modifier/high bits; motion ORs +32.
  const cb = (opts?.release ? (btn & ~0b11) | 0b11 : btn) + motion;
  // Input reaches the PTY UTF-8-encoded; clamp each field ≤127 for one byte.
  const enc = (n: number) => String.fromCharCode(Math.min(127, n + 32));
  return `\x1b[M${enc(cb)}${enc(col)}${enc(row)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && bun test src/mouseSeq.test.ts`
Expected: PASS — new cases plus the original wheel/X10 cases (unchanged).

- [ ] **Step 5: Commit**

```bash
cd apps/mobile && bun format
git add apps/mobile/src/mouseSeq.ts apps/mobile/src/mouseSeq.test.ts
git commit -m "feat(mouseSeq): encode release and motion events"
```

---

### Task 3: Shared gesture→event helper (`mouseInput.ts`)

Pure functions both UI paths call: cell math + click/drag sequence builders that respect mode.

**Files:**
- Create: `apps/mobile/src/mouseInput.ts`
- Test: `apps/mobile/src/mouseInput.test.ts`

**Interfaces:**
- Consumes: `mouseSeq` (Task 2); `MouseMode` (Task 1).
- Produces:
  - `cellFromPoint(x, y, rect: { left: number; top: number; width: number; height: number }, cols: number, rows: number): { col: number; row: number }`
  - `clickSeqs(col: number, row: number, mode: MouseMode, sgr: boolean, btn?: number, mods?: number): string[]`
  - `pressSeq(col, row, sgr, btn?, mods?): string`
  - `motionSeq(col, row, mode, sgr, btn?, mods?): string | null` (null unless mode is 'button'|'any')
  - `releaseSeq(col, row, mode, sgr, btn?, mods?): string | null` (null when mode is 'x10')

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/mouseInput.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { cellFromPoint, clickSeqs, motionSeq, pressSeq, releaseSeq } from './mouseInput';

const rect = { left: 0, top: 0, width: 800, height: 480 }; // 80 cols × 24 rows → 10px cell

describe('cellFromPoint', () => {
  it('maps a point to a 1-based clamped cell', () => {
    expect(cellFromPoint(0, 0, rect, 80, 24)).toEqual({ col: 1, row: 1 });
    expect(cellFromPoint(15, 25, rect, 80, 24)).toEqual({ col: 2, row: 3 });
    expect(cellFromPoint(10000, 10000, rect, 80, 24)).toEqual({ col: 80, row: 24 });
    expect(cellFromPoint(-50, -50, rect, 80, 24)).toEqual({ col: 1, row: 1 });
  });
});

describe('clickSeqs', () => {
  it('press+release in normal mode (SGR)', () => {
    expect(clickSeqs(5, 3, 'normal', true)).toEqual(['\x1b[<0;5;3M', '\x1b[<0;5;3m']);
  });
  it('press only in x10 mode', () => {
    expect(clickSeqs(5, 3, 'x10', true)).toEqual(['\x1b[<0;5;3M']);
  });
});

describe('drag builders', () => {
  it('motionSeq null unless button/any', () => {
    expect(motionSeq(5, 3, 'normal', true)).toBeNull();
    expect(motionSeq(5, 3, 'x10', true)).toBeNull();
    expect(motionSeq(5, 3, 'button', true)).toBe('\x1b[<32;5;3M');
    expect(motionSeq(5, 3, 'any', true)).toBe('\x1b[<32;5;3M');
  });
  it('releaseSeq null in x10, else final m', () => {
    expect(releaseSeq(5, 3, 'x10', true)).toBeNull();
    expect(releaseSeq(5, 3, 'button', true)).toBe('\x1b[<0;5;3m');
  });
  it('pressSeq encodes a plain press', () => {
    expect(pressSeq(5, 3, true)).toBe('\x1b[<0;5;3M');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && bun test src/mouseInput.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/mobile/src/mouseInput.ts`:

```ts
// Pure helpers shared by the mobile gesture path and the desktop mouse path:
// map a pointer coordinate to a terminal cell, and build the byte sequences for
// clicks and drags honouring the app's negotiated mouse mode + SGR encoding.
import { mouseSeq } from './mouseSeq';
import type { MouseMode } from './terminal';

export function cellFromPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  cols: number,
  rows: number,
): { col: number; row: number } {
  const col = Math.min(cols, Math.max(1, Math.floor((x - rect.left) / (rect.width / cols)) + 1));
  const row = Math.min(rows, Math.max(1, Math.floor((y - rect.top) / (rect.height / rows)) + 1));
  return { col, row };
}

export function pressSeq(col: number, row: number, sgr: boolean, btn = 0, mods = 0): string {
  return mouseSeq(btn + mods, col, row, sgr);
}

export function releaseSeq(
  col: number,
  row: number,
  mode: MouseMode,
  sgr: boolean,
  btn = 0,
  mods = 0,
): string | null {
  if (mode === 'x10') return null; // X10 reports press only
  return mouseSeq(btn + mods, col, row, sgr, { release: true });
}

export function motionSeq(
  col: number,
  row: number,
  mode: MouseMode,
  sgr: boolean,
  btn = 0,
  mods = 0,
): string | null {
  if (mode !== 'button' && mode !== 'any') return null; // motion only in 1002/1003
  return mouseSeq(btn + mods, col, row, sgr, { motion: true });
}

export function clickSeqs(
  col: number,
  row: number,
  mode: MouseMode,
  sgr: boolean,
  btn = 0,
  mods = 0,
): string[] {
  const seqs = [pressSeq(col, row, sgr, btn, mods)];
  const rel = releaseSeq(col, row, mode, sgr, btn, mods);
  if (rel) seqs.push(rel);
  return seqs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && bun test src/mouseInput.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd apps/mobile && bun format
git add apps/mobile/src/mouseInput.ts apps/mobile/src/mouseInput.test.ts
git commit -m "feat(mouseInput): shared cell math + click/drag sequence builders"
```

---

### Task 4: User kill switch (`mouseEnabled`) + `mouseActive` gate

Add a persisted preference and route the existing gate through it, before any new wiring exists. This task changes only the gate wiring for the *current* (wheel) behaviour, proving the switch works.

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx` (storage keys ~top; `mouseOn` state ~182 / `mouseOnRef` ~359; load block ~907-928; wheel gates ~435-437, ~1458; `scrollEnabled` ~2066; hook return ~2121)
- Modify: `apps/mobile/src/OverflowMenu.tsx` (props + a new toggle row)
- Modify: `apps/mobile/src/TerminalScreen.tsx` (pass the new props to `OverflowMenu`)
- Test: manual (UI state) + `bun run typecheck`

**Interfaces:**
- Consumes: nothing new.
- Produces: `mouseEnabled: boolean` + `setMouseEnabled` in the hook return; `mouseActive` derived value used by all gates; `OverflowMenu` gains `mouseEnabled: boolean` and `onToggleMouse: () => void` props.

- [ ] **Step 1: Add the storage key and state**

In `useTetherApp.tsx`, next to the other `KEY_*` constants (e.g. `KEY_FONT`), add:

```ts
const KEY_MOUSE_ENABLED = '@tether/mouseEnabled';
```

Next to `const [mouseOn, setMouseOn] = useState(false);` (~182) add:

```ts
  const [mouseEnabled, setMouseEnabled] = useState(true);
  const mouseEnabledRef = useRef(true); // stable mirror for gesture handlers
```

- [ ] **Step 2: Load + persist**

In the startup load (the `Promise.all([...AsyncStorage.getItem...])` block ~907), add `AsyncStorage.getItem(KEY_MOUSE_ENABLED).catch(() => null)` to the array, and after parsing `savedFont` add:

```ts
        if (savedMouseEnabled === 'false') {
          setMouseEnabled(false);
          mouseEnabledRef.current = false;
        }
```

(name the destructured value `savedMouseEnabled` matching its position in the array).

Add a toggle handler near the other `AsyncStorage.setItem` handlers:

```ts
  const toggleMouseEnabled = () => {
    setMouseEnabled((prev) => {
      const next = !prev;
      mouseEnabledRef.current = next;
      AsyncStorage.setItem(KEY_MOUSE_ENABLED, String(next)).catch(() => {});
      return next;
    });
  };
```

- [ ] **Step 3: Route every gate through `mouseActive`**

Add near the render-derived values:

```ts
  const mouseActive = mouseOn && mouseEnabled;
```

- `scrollEnabled={!mouseOn}` (~2066) → `scrollEnabled={!mouseActive}`.
- Desktop wheel guard `if (!term?.mouseOn) return;` (~1458) → also require the ref: `if (!term?.mouseOn || !mouseEnabledRef.current) return;`.
- PanResponder wheel predicates (~435-437) `mouseOnRef.current && …` → `mouseOnRef.current && mouseEnabledRef.current && …`.

Add `mouseEnabled`, `setMouseEnabled: toggleMouseEnabled`, and `mouseActive` to the hook's return object (~2121).

- [ ] **Step 4: Add the toggle to OverflowMenu**

In `OverflowMenu.tsx`, add to the props type and destructure: `mouseEnabled: boolean;` and `onToggleMouse: () => void;`. Add a menu row after the Font size row:

```tsx
          <TouchableOpacity style={styles.menuRow} onPress={onToggleMouse}>
            <Feather name="mouse-pointer" size={16} color={theme.colors.text} />
            <Text style={[styles.menuRowText, { flex: 1 }]} numberOfLines={1}>
              Mouse control
            </Text>
            <Feather
              name={mouseEnabled ? 'toggle-right' : 'toggle-left'}
              size={20}
              color={mouseEnabled ? theme.colors.accent : theme.colors.textDim}
            />
          </TouchableOpacity>
```

(If `theme.colors.accent`/`textDim` don't exist, use the names present in `appTheme.ts` — check `AppColors`.)

In `TerminalScreen.tsx` where `<OverflowMenu ... />` is rendered, pass `mouseEnabled={mouseEnabled}` and `onToggleMouse={toggleMouseEnabled}` (both come from the hook; add them to the destructure from `useTetherApp` in this component).

- [ ] **Step 5: Verify typecheck + manual behaviour**

Run: `cd apps/mobile && bun run typecheck && bun lint`
Expected: clean.

Manual (desktop, `npx expo run:ios` not needed — use `bun dev:mobile` web or the desktop app against a running server): open a mouse-reporting app (e.g. `htop`), open `⋯` → toggle **Mouse control** off → the list scrolls natively again and the toggle persists across reload. Toggle on → wheel forwarding resumes.

- [ ] **Step 6: Commit**

```bash
cd apps/mobile && bun format
git add apps/mobile/src/useTetherApp.tsx apps/mobile/src/OverflowMenu.tsx apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(mouse): user kill switch for mouse control (mouseActive gate)"
```

---

### Task 5: Desktop mouse listeners (click + drag + Shift bypass)

Wire real `mousedown`/`mousemove`/`mouseup` on `#tether-terminal` when `mouseActive`, using the Task 3 helpers.

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx` (new `useEffect` beside the existing desktop `onWheel` effect ~1446)
- Test: manual + `bun run typecheck` (DOM listeners; the sequence logic is already unit-tested in Task 3)

**Interfaces:**
- Consumes: `cellFromPoint`, `pressSeq`, `motionSeq`, `releaseSeq` (Task 3); `mouseActive` gate via refs (Task 4); `wsSend`.

- [ ] **Step 1: Add the effect**

Import the helpers at the top of `useTetherApp.tsx`:

```ts
import { cellFromPoint, motionSeq, pressSeq, releaseSeq } from './mouseInput';
```

Add a `useEffect` next to the `onWheel` effect. It only attaches on desktop; it reads live emulator state from the cache each event (same pattern as `onWheel`). Track the last-reported cell and whether a button is down across events with refs local to the effect:

```ts
  // Desktop: forward real mouse click/drag to the PTY when the app enabled mouse
  // reporting and the user hasn't disabled it. Shift bypasses reporting so native
  // text selection still works (xterm.js convention).
  useEffect(() => {
    if (isDesktop === false || isConfiguring) return;
    const el = () => document.getElementById('tether-terminal');
    let down = false;
    let lastCol = 0;
    let lastRow = 0;

    const cellOf = (e: MouseEvent, term: { cols: number; rows: number }) => {
      const node = el();
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return cellFromPoint(e.clientX, e.clientY, rect, term.cols || 80, term.rows || 24);
    };
    const modsOf = (e: MouseEvent) => (e.altKey ? 8 : 0) | (e.ctrlKey ? 16 : 0);
    const activeTerm = () => {
      const term = cache.get(activeIdRef.current)?.term;
      if (!term?.mouseOn || !mouseEnabledRef.current) return null;
      return term;
    };

    const onDown = (e: MouseEvent) => {
      const node = el();
      if (!node || !(e.target instanceof Node) || !node.contains(e.target)) return;
      if (e.shiftKey) return; // native selection
      const term = activeTerm();
      if (!term) return;
      const cell = cellOf(e, term);
      if (!cell) return;
      e.preventDefault();
      down = true;
      lastCol = cell.col;
      lastRow = cell.row;
      wsSend({ type: 'input', text: pressSeq(cell.col, cell.row, term.mouseSgr, e.button, modsOf(e)) });
    };
    const onMove = (e: MouseEvent) => {
      if (!down) return;
      const term = activeTerm();
      if (!term) return;
      const cell = cellOf(e, term);
      if (!cell || (cell.col === lastCol && cell.row === lastRow)) return;
      lastCol = cell.col;
      lastRow = cell.row;
      const seq = motionSeq(cell.col, cell.row, term.mouseMode, term.mouseSgr, e.button, modsOf(e));
      if (seq) wsSend({ type: 'input', text: seq });
    };
    const onUp = (e: MouseEvent) => {
      if (!down) return;
      down = false;
      const term = activeTerm();
      if (!term) return;
      const cell = cellOf(e, term) ?? { col: lastCol, row: lastRow };
      const seq = releaseSeq(cell.col, cell.row, term.mouseMode, term.mouseSgr, e.button, modsOf(e));
      if (seq) wsSend({ type: 'input', text: seq });
    };

    window.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfiguring]);
```

Note: `e.button` is already 0/1/2 for left/middle/right — the exact Cb button bits.

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/mobile && bun run typecheck && bun lint`
Expected: clean.

- [ ] **Step 3: Manual test on desktop**

Against a running server, open the desktop app; run `vim`, `:set mouse=a`. Click positions the cursor; click-drag selects (visual mode). In `tmux` with mouse on, click selects panes and drag resizes. Hold **Shift** and drag → native browser text selection instead. Toggle **Mouse control** off → clicks stop reaching the app.

- [ ] **Step 4: Commit**

```bash
cd apps/mobile && bun format
git add apps/mobile/src/useTetherApp.tsx
git commit -m "feat(desktop): forward mouse click/drag to PTY with Shift bypass"
```

---

### Task 6: Mobile gesture wiring (tap=click, 1-finger pan=drag, 2-finger=wheel)

Route touch through the helpers when `mouseActive`. Tap → click (instead of focusing the keyboard); 1-finger pan → drag; 2-finger vertical pan → the existing wheel path; long-press → selection overlay (unchanged).

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx` (`panResponder` ~432-463; expose a `terminalTapRef`/handler)
- Modify: `apps/mobile/src/TerminalScreen.tsx` (Pressable `onPress` ~586; capture surface layout for cell math)
- Test: manual + `bun run typecheck`

**Interfaces:**
- Consumes: `cellFromPoint`, `clickSeqs`, `pressSeq`, `motionSeq`, `releaseSeq` (Task 3); `mouseActive`/refs (Task 4); the terminal surface layout rect.

- [ ] **Step 1: Capture the terminal surface rect**

The gesture handlers need the on-screen rect of the terminal grid to map touches to cells. In `useTetherApp.tsx` add a ref + measured rect state near `dimsRef`:

```ts
  const termRectRef = useRef({ left: 0, top: 0, width: 0, height: 0 });
```

In `TerminalScreen.tsx`, on the terminal-surface `View` that already has `onLayout={(e) => setTermHeight(...)}` (~553), extend `onLayout` to also report the absolute rect up to the hook via a passed setter `setTermRect` (add it to the hook return). Use `e.nativeEvent.layout` for width/height and `measureInWindow` for absolute left/top:

```tsx
                onLayout={(e) => {
                  setTermHeight(e.nativeEvent.layout.height);
                  e.currentTarget.measureInWindow((x, y, w, h) =>
                    setTermRect({ left: x, top: y, width: w, height: h }),
                  );
                }}
```

Add `setTermRect` to the hook: `const setTermRect = (r) => { termRectRef.current = r; };` and return it. Type `r` as `{ left: number; top: number; width: number; height: number }`.

- [ ] **Step 2: Tap → click**

In `TerminalScreen.tsx` the Pressable `onPress` (~586) currently focuses the input. Change it to click when mouse is active, else focus:

```tsx
                    onPress={(e) => {
                      if (scrolledRef.current) return;
                      if (!onTerminalTap(e.nativeEvent.pageX, e.nativeEvent.pageY)) {
                        inputRef.current?.focus();
                      }
                    }}
```

Add `onTerminalTap` to the hook (returns `true` when it consumed the tap as a click):

```ts
  const onTerminalTap = (pageX: number, pageY: number): boolean => {
    const term = cache.get(activeIdRef.current)?.term;
    if (!term?.mouseOn || !mouseEnabledRef.current) return false;
    const { col, row } = cellFromPoint(
      pageX, pageY, termRectRef.current, term.cols || 80, term.rows || 24,
    );
    for (const text of clickSeqs(col, row, term.mouseMode, term.mouseSgr)) {
      wsSend({ type: 'input', text });
    }
    return true;
  };
```

Return `onTerminalTap` from the hook and destructure it in `TerminalScreen`.

- [ ] **Step 3: Pan → drag (1 finger) vs wheel (2 fingers)**

Rewrite the `panResponder` (~432) so it claims 1-finger pans for drag and 2-finger pans for wheel, only when `mouseActive`:

```ts
  const dragCell = useRef({ col: 0, row: 0 });
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        mouseOnRef.current && mouseEnabledRef.current &&
        (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4),
      onMoveShouldSetPanResponderCapture: (_, g) =>
        mouseOnRef.current && mouseEnabledRef.current &&
        (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4),
      onPanResponderGrant: (e, g) => {
        lastDy.current = 0;
        wheelAccum.current = 0;
        if (g.numberActiveTouches >= 2) return; // wheel path, no press
        const term = cache.get(activeIdRef.current)?.term;
        if (!term) return;
        const { col, row } = cellFromPoint(
          e.nativeEvent.pageX, e.nativeEvent.pageY, termRectRef.current,
          term.cols || 80, term.rows || 24,
        );
        dragCell.current = { col, row };
        wsSend({ type: 'input', text: pressSeq(col, row, term.mouseSgr) });
      },
      onPanResponderMove: (e, g) => {
        const term = cache.get(activeIdRef.current)?.term;
        if (!term) return;
        if (g.numberActiveTouches >= 2) {
          // Two-finger: existing wheel scroll.
          const STEP = 22;
          const delta = g.dy - lastDy.current;
          lastDy.current = g.dy;
          wheelAccum.current += delta;
          const col = Math.max(1, Math.floor((term.cols || 80) / 2));
          const row = Math.max(1, Math.floor((term.rows || 24) / 2));
          const wheel = (btn: number) =>
            wsSend({ type: 'input', text: mouseSeq(btn, col, row, term.mouseSgr) });
          while (wheelAccum.current >= STEP) { wheel(64); wheelAccum.current -= STEP; }
          while (wheelAccum.current <= -STEP) { wheel(65); wheelAccum.current += STEP; }
          return;
        }
        // One-finger: drag motion when the cell changes.
        const { col, row } = cellFromPoint(
          e.nativeEvent.pageX, e.nativeEvent.pageY, termRectRef.current,
          term.cols || 80, term.rows || 24,
        );
        if (col === dragCell.current.col && row === dragCell.current.row) return;
        dragCell.current = { col, row };
        const seq = motionSeq(col, row, term.mouseMode, term.mouseSgr);
        if (seq) wsSend({ type: 'input', text: seq });
      },
      onPanResponderRelease: (_, g) => {
        if (g.numberActiveTouches >= 1) return; // still touching (multi-touch lift)
        const term = cache.get(activeIdRef.current)?.term;
        if (!term) return;
        const { col, row } = dragCell.current;
        const seq = releaseSeq(col, row, term.mouseMode, term.mouseSgr);
        if (seq) wsSend({ type: 'input', text: seq });
      },
    }),
  ).current;
```

Keep the `import { mouseSeq } from './mouseSeq';` (still used for the wheel path) and add the `mouseInput` import if not already present from Task 5. Note the gate change: 2-finger pan keeps wheel scroll even when the app is in a motion mode, because the user's intent to scroll history should win over drag.

- [ ] **Step 4: Verify typecheck + lint**

Run: `cd apps/mobile && bun run typecheck && bun lint`
Expected: clean.

- [ ] **Step 5: Manual test on device**

Build to a device (`cd apps/mobile && npx expo run:ios --device`). In `vim` with `:set mouse=a`: single tap moves the cursor; one-finger drag selects (visual). In `htop`: tap a row/column header. Two-finger vertical drag scrolls history. Long-press still opens the selection overlay. `⋯` → Mouse control off → tap focuses the keyboard again and one-finger swipe scrolls natively.

- [ ] **Step 6: Commit**

```bash
cd apps/mobile && bun format
git add apps/mobile/src/useTetherApp.tsx apps/mobile/src/TerminalScreen.tsx
git commit -m "feat(mobile): tap=click, 1-finger drag, 2-finger scroll for mouse mode"
```

---

### Task 7: Final verification + changelog

**Files:**
- Modify: `docs/changelog.md`
- Test: full suite

- [ ] **Step 1: Full test + lint gate**

Run: `cd apps/mobile && bun test && bun run typecheck && bun lint`
Expected: all green.

- [ ] **Step 2: Add changelog entry**

At the top of `docs/changelog.md` (newest first, above the latest entry), add:

```markdown
## v1.16 — mouse click & drag

- **Mouse reporting** — tap/click and drag now reach the PTY, so vim mouse mode, tmux pane clicks, and htop/mc work on phone and desktop. Mobile: tap = click, one-finger drag = drag-select, two-finger scroll = wheel. Desktop: real mouse, with Shift held to bypass for native selection.
- **Mouse control toggle** (⋯ menu) to disable forwarding on demand.
```

(Adjust the version to whatever the next release will be.)

- [ ] **Step 3: Commit**

```bash
git add docs/changelog.md
git commit -m "docs: changelog for mouse click/drag reporting"
```

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/mouse-reporting
```

---

## Notes for the implementer

- `#tether-terminal` is the `nativeID` of the terminal surface on both platforms; on web/desktop it resolves to a DOM id.
- The emulator instance for the active session is `cache.get(activeIdRef.current)?.term`. Read `term.mouseMode`, `term.mouseSgr`, `term.cols`, `term.rows` off it live — do not snapshot into React state (it lags a frame).
- `wsSend` already guards on socket readiness; call it freely.
- Do not touch the server — this is entirely client-side; the server already relays `{type:'input'}` bytes to the PTY verbatim.
