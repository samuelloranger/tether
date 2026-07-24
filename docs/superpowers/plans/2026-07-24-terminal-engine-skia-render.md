# Terminal Engine Skia Render (Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the mobile terminal as a pixel-accurate Skia cell grid (fixing wide-char/box-drawing alignment and fast-scroll perf), keeping the desktop/web `<Text>` renderer untouched.

**Architecture:** Add `getGrid()` to `TerminalEngine` (cell-level snapshot with per-cell width/color/attrs + OSC 8 link spans). Split the render into `TerminalView.native.tsx` (new Skia canvas, single canvas + virtual scroll) and `TerminalView.tsx` (existing `<Text>` path extracted, web/desktop only). Wire it into `TerminalScreen`.

**Tech Stack:** Expo 57 / RN 0.86 / Hermes, `@shopify/react-native-skia`, RN `PanResponder`, `bun test`, Biome.

## Global Constraints

- Expo pinned at **57.0.7** — do NOT bump (jsi Swift patch keyed to it; iOS build breaks otherwise).
- **Native platforms only.** All new render code lives in `.native.tsx`. The web/desktop `<Text>` path is frozen — zero changes to its behavior (desktop is slated for a future libghostty rewrite).
- **Links are required**: both regex URLs and OSC 8 hyperlinks must be tappable in the Skia renderer.
- New native dependency: `@shopify/react-native-skia` (exact version resolved in Phase 0). Reanimated only if that skia version requires it.
- The grid is authoritative for layout, not font metrics: wide cells occupy exactly `2*cellW` regardless of the glyph's measured width.
- Formatting: Biome (2-space, single quotes, semicolons, trailing commas, width 100). `bun format` before each commit.
- Tests: `bun test` from `apps/mobile`; `bun:test` style.
- Reuse, don't reinvent: `links.ts`, `mouseSeq.ts`/`cellFromPoint`/`clickSeqs`, `wordAt`, `SelectionView`, theme wiring stay.

### Engine `getGrid()` contract (added in Task 2)

```ts
interface GridCell { char: string; width: 0 | 1 | 2; fg: string; bg: string; attrs: number }
// attrs bitmask:
const A_BOLD = 1, A_DIM = 2, A_ITALIC = 4, A_UNDERLINE = 8, A_STRIKE = 16, A_INVERSE = 32;
interface GridRow { key: number; cells: GridCell[]; wrapped: boolean; promptStart: boolean; links: LinkSpan[] }
interface GridSnapshot {
  rows: GridRow[];
  cursor: { row: number; col: number; style: 'block' | 'bar' | 'underline'; visible: boolean };
  cols: number;
  rowCount: number;
  baseY: number;
}
// on TerminalEngine:
getGrid(): GridSnapshot   // fg/bg are resolved hex (default => '' meaning "theme default")
```

---

## File Structure

- **Create** `apps/mobile/src/terminalGrid.test.ts` — `getGrid()` + cell-metric unit tests.
- **Modify** `apps/mobile/src/terminalEngine.ts` — add `getGrid()`, attrs bitmask, OSC 8 link tracking.
- **Create** `apps/mobile/src/skiaProbe.native.tsx` (Phase 0, throwaway) — proves Skia builds/renders.
- **Create** `apps/mobile/src/TerminalCanvas.native.tsx` — the Skia renderer (paint + scroll + cursor + hit-test).
- **Create** `apps/mobile/src/canvasGeometry.ts` — pure cell⇄pixel math (unit-tested).
- **Create** `apps/mobile/src/TerminalView.tsx` — extracted existing `<Text>` FlatList block (web/desktop).
- **Create** `apps/mobile/src/TerminalView.native.tsx` — thin wrapper choosing `TerminalCanvas`.
- **Modify** `apps/mobile/src/TerminalScreen.tsx` — replace the inline terminal-grid block with `<TerminalView …/>`.
- **Modify** `apps/mobile/src/useTetherApp.tsx` — expose `getGrid`-based render path + canvas scroll/tap wiring on native.

---

## Task 1: Phase 0 — Skia build & render gate (throwaway)

**GATE. Do not proceed to Task 2+ until this passes on Android sim AND a real iOS build.**

**Files:**
- Modify: `apps/mobile/package.json`
- Create: `apps/mobile/src/skiaProbe.native.tsx`
- Modify: `apps/mobile/App.tsx` (temporary mount)

- [ ] **Step 1: Install Skia (let Expo pick the compatible version)**

```bash
cd apps/mobile && bunx expo install @shopify/react-native-skia
```
Record the resolved version and whether it pulled `react-native-reanimated` (note it in the commit message).

- [ ] **Step 2: Write the probe component**

Create `apps/mobile/src/skiaProbe.native.tsx`:

```tsx
import { Canvas, Fill, Rect, Text, matchFont } from '@shopify/react-native-skia';
import React from 'react';
import { View } from 'react-native';

export function SkiaProbe() {
  const font = matchFont({ fontFamily: 'monospace', fontSize: 16 });
  const advance = font?.measureText('M').width ?? -1;
  console.log('[SKIA_PROBE] font advance for M =', advance);
  return (
    <View style={{ width: 200, height: 80 }}>
      <Canvas style={{ flex: 1 }}>
        <Fill color="#1e1e2e" />
        <Rect x={4} y={4} width={40} height={20} color="#89b4fa" />
        {font ? <Text x={4} y={50} text="Skia OK 你好" font={font} color="#a6e3a1" /> : null}
      </Canvas>
    </View>
  );
}
```

- [ ] **Step 3: Temporarily mount it**

In `apps/mobile/App.tsx`, render `<SkiaProbe/>` above the app root (guard behind `Platform.OS !== 'web'`). Import from `./src/skiaProbe`.

- [ ] **Step 4: Build & run on Android sim**

```bash
export ANDROID_HOME=/home/samuelloranger/Android/Sdk QT_QPA_PLATFORM=offscreen
$ANDROID_HOME/emulator/emulator -avd tether_test -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect &
# wait boot; then:
cd apps/mobile && (bun x expo start --dev-client --port 8081 &) && cd android && ./gradlew :app:assembleDebug -x lint
adb install -r app/build/outputs/apk/debug/app-debug.apk && adb reverse tcp:8081 tcp:8081
adb shell monkey -p com.samuelloranger.tethermobile -c android.intent.category.LAUNCHER 1
adb logcat -d | grep -a "SKIA_PROBE\|includes' of undefined\|FATAL\|ReactNativeJS.*[Ee]rror"
```
Expected: `[SKIA_PROBE] font advance for M = <positive number>`, no crash, blue rect + green "Skia OK 你好" visible.

- [ ] **Step 5: Build & run on a real iOS device**

```bash
cd apps/mobile && npx expo run:ios --device
```
Expected: builds clean on the pinned jsi patch; probe renders; `advance` logged. **If the iOS build fails on jsi, STOP** — report to the user; fallback is hardening the `<Text>` renderer (out of scope for this plan).

- [ ] **Step 6: Revert the probe, commit only the dep**

```bash
cd apps/mobile && git checkout App.tsx && rm src/skiaProbe.native.tsx
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/package.json bun.lock
git commit -m "build(mobile): add @shopify/react-native-skia (Phase 0 gate passed: Android+iOS render OK)"
```

---

## Task 2: Engine `getGrid()` + OSC 8 link tracking

**Files:**
- Modify: `apps/mobile/src/terminalEngine.ts`
- Test: `apps/mobile/src/terminalGrid.test.ts`

**Interfaces:**
- Consumes: existing `TerminalEngine` internals (buffer read, `promptIds`, `trimmedCount`, `computeLinkSpans`).
- Produces: `getGrid(): GridSnapshot`; exported `A_BOLD…A_INVERSE` consts and `GridCell/GridRow/GridSnapshot` types.

- [ ] **Step 1: Write failing tests**

Create `apps/mobile/src/terminalGrid.test.ts`:

```ts
import { expect, test } from 'bun:test';
import '../src/xtermPolyfill';
import { A_BOLD, A_INVERSE, TerminalEngine } from './terminalEngine';

async function w(t: TerminalEngine, d: string) { t.write(d); await t.drain(); }
const E = '\x1b';

test('getGrid: cell char/width/color/attrs', async () => {
  const t = new TerminalEngine(20, 4);
  await w(t, `${E}[1;38;2;255;0;0mA${E}[0m你`);
  const g = t.getGrid();
  const row0 = g.rows[0].cells;
  expect(row0[0].char).toBe('A');
  expect(row0[0].width).toBe(1);
  expect(row0[0].fg.toLowerCase()).toBe('#ff0000');
  expect(row0[0].attrs & A_BOLD).toBeTruthy();
  expect(row0[1].width).toBe(2);       // 你
  expect(row0[2].width).toBe(0);       // spacer cell
});

test('getGrid: cursor position + default color sentinel', async () => {
  const t = new TerminalEngine(20, 4);
  await w(t, 'hi');
  const g = t.getGrid();
  expect(g.cursor.col).toBe(2);
  expect(g.cursor.row).toBe(0);
  expect(g.rows[0].cells[0].fg).toBe(''); // '' = theme default
});

test('getGrid: OSC 8 hyperlink becomes a tappable link span', async () => {
  const t = new TerminalEngine(40, 4);
  await w(t, `${E}]8;;https://ex.com${E}\\CLICK${E}]8;;${E}\\`);
  const links = t.getGrid().rows[0].links;
  expect(links.length).toBe(1);
  expect(links[0].target).toEqual({ kind: 'external', url: 'https://ex.com' });
  expect(links[0].start).toBe(0);
  expect(links[0].end).toBe(5); // "CLICK"
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd apps/mobile && bun test src/terminalGrid.test.ts
```
Expected: FAIL (`getGrid`/`A_BOLD` undefined).

- [ ] **Step 3: Implement attrs bitmask + getGrid**

In `terminalEngine.ts`, add near the top-level helpers:

```ts
export const A_BOLD = 1, A_DIM = 2, A_ITALIC = 4, A_UNDERLINE = 8, A_STRIKE = 16, A_INVERSE = 32;
export interface GridCell { char: string; width: 0 | 1 | 2; fg: string; bg: string; attrs: number }
export interface GridRow { key: number; cells: GridCell[]; wrapped: boolean; promptStart: boolean; links: LinkSpan[] }
export interface GridSnapshot {
  rows: GridRow[];
  cursor: { row: number; col: number; style: 'block' | 'bar' | 'underline'; visible: boolean };
  cols: number;
  rowCount: number;
  baseY: number;
}

function attrsOf(cell: IBufferCell): number {
  let a = 0;
  if (cell.isBold()) a |= A_BOLD;
  if (cell.isDim()) a |= A_DIM;
  if (cell.isItalic()) a |= A_ITALIC;
  if (cell.isUnderline()) a |= A_UNDERLINE;
  if (cell.isStrikethrough()) a |= A_STRIKE;
  if (cell.isInverse()) a |= A_INVERSE;
  return a;
}
```

Add the method (mirrors `getSnapshot`'s buffer walk, emits cells; reuses `computeLinkSpans` for regex links and merges the OSC 8 spans tracked in Step 4):

```ts
getGrid(): GridSnapshot {
  const buf = this.term.buffer.active;
  const total = buf.length;
  const trimmed = this.trimmedCount();
  const cursorAbs = buf.baseY + buf.cursorY;
  const rows: GridRow[] = new Array(total);
  const texts: string[] = new Array(total);
  const wrappedFlags: boolean[] = new Array(total);
  for (let y = 0; y < total; y++) {
    const line = buf.getLine(y);
    const cells: GridCell[] = [];
    let text = '';
    if (line) {
      for (let x = 0; x < line.length; x++) {
        const c = line.getCell(x, this.cell);
        this.cell = c;
        if (!c) continue;
        const width = c.getWidth() as 0 | 1 | 2;
        const char = c.getChars() || (width === 0 ? '' : ' ');
        cells.push({ char, width, fg: fgOf(c) ?? '', bg: bgOf(c) ?? '', attrs: attrsOf(c) });
        if (width !== 0) text += char;
      }
    }
    rows[y] = {
      key: trimmed + y,
      cells,
      wrapped: line?.isWrapped ?? false,
      promptStart: this.promptIds.has(trimmed + y),
      links: [],
    };
    texts[y] = text;
    wrappedFlags[y] = rows[y].wrapped;
  }
  const regex = computeLinkSpans(texts, wrappedFlags);
  for (let y = 0; y < total; y++) {
    const osc8 = this.osc8Spans.get(trimmed + y) ?? [];
    rows[y].links = osc8.length ? osc8 : (regex[y] ?? []);
  }
  return {
    rows,
    cursor: {
      row: cursorAbs,
      col: buf.cursorX,
      style: this.cursorStyle,
      visible: this.term.options.cursorInactiveStyle !== 'none',
    },
    cols: this.term.cols,
    rowCount: this.term.rows,
    baseY: buf.baseY,
  };
}
```

- [ ] **Step 4: Track OSC 8 spans**

Add fields + handler in the constructor. OSC 8 form is `params;URI` (empty URI closes). Record the open URI + start (logical id + column), and on close/next-open, push a span.

```ts
// fields:
private osc8Spans = new Map<number, LinkSpan[]>(); // logical row id -> spans
private osc8Open: { url: string; startId: number; startCol: number } | null = null;

// in constructor:
this.term.parser.registerOscHandler(8, (data) => {
  const semi = data.indexOf(';');
  const uri = semi === -1 ? '' : data.slice(semi + 1);
  this.closeOsc8(); // finalize any open link at current cursor
  if (uri) this.osc8Open = { url: uri, startId: this.cursorLogicalId(), startCol: this.term.buffer.active.cursorX };
  return true;
});
```

Add `closeOsc8()` (records the span from the open marker to the current cursor; handles same-row case; multi-row links record on the start row for hit-test simplicity):

```ts
private closeOsc8(): void {
  const o = this.osc8Open;
  if (!o) return;
  this.osc8Open = null;
  const endId = this.cursorLogicalId();
  const endCol = this.term.buffer.active.cursorX;
  const end = endId === o.startId ? endCol : this.term.cols; // clamp multi-row to row end
  if (end <= o.startCol) return;
  const list = this.osc8Spans.get(o.startId) ?? [];
  list.push({ start: o.startCol, end, target: { kind: 'external', url: o.url } });
  this.osc8Spans.set(o.startId, list);
}
```

Prune `osc8Spans` for trimmed rows inside `getGrid` (same pattern as `promptIds`):

```ts
if (this.osc8Spans.size) for (const id of this.osc8Spans.keys()) if (id < trimmed) this.osc8Spans.delete(id);
```

Clear both in `reset()`: `this.osc8Spans.clear(); this.osc8Open = null;`

- [ ] **Step 5: Run tests**

```bash
cd apps/mobile && bun test src/terminalGrid.test.ts
```
Expected: PASS. If the OSC 8 span end is wrong, log `startCol`/`endCol`/`cursorX` around the write and adjust (BEL vs ST terminator differences).

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/src/terminalEngine.ts apps/mobile/src/terminalGrid.test.ts
git commit -m "feat(mobile): engine getGrid() cell snapshot + OSC 8 link tracking"
```

---

## Task 3: Cell⇄pixel geometry (pure, unit-tested)

**Files:**
- Create: `apps/mobile/src/canvasGeometry.ts`
- Test: `apps/mobile/src/canvasGeometry.test.ts`

**Interfaces:**
- Produces: `cellMetrics`, `pointToCell`, `visibleRange`.

- [ ] **Step 1: Write failing tests**

Create `apps/mobile/src/canvasGeometry.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { cellMetrics, pointToCell, visibleRange } from './canvasGeometry';

test('cellMetrics from advance + fontSize', () => {
  const m = cellMetrics(8, 11, 1.3);
  expect(m.cellW).toBe(8);
  expect(m.cellH).toBe(Math.round(11 * 1.3));
});

test('pointToCell maps pixel (incl scroll) to row/col', () => {
  const m = cellMetrics(8, 10, 1.3); // cellH=13
  expect(pointToCell(20, 0, 0, m)).toEqual({ col: 2, row: 0 });
  expect(pointToCell(20, 26, 13, m)).toEqual({ col: 2, row: 3 }); // scrollTop 13 -> +1 row; y26 -> +2
});

test('visibleRange clamps to grid', () => {
  const m = cellMetrics(8, 10, 1.3);
  expect(visibleRange(13, 40, 100, m)).toEqual({ first: 1, last: 5 }); // scrollTop 13/13=1 .. +40/13≈3 +1 pad
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd apps/mobile && bun test src/canvasGeometry.test.ts
```
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `apps/mobile/src/canvasGeometry.ts`:

```ts
export interface CellMetrics { cellW: number; cellH: number }

export function cellMetrics(advance: number, fontSize: number, lineHeightRatio = 1.3): CellMetrics {
  return { cellW: advance, cellH: Math.round(fontSize * lineHeightRatio) };
}

export function pointToCell(x: number, y: number, scrollTop: number, m: CellMetrics) {
  return { col: Math.max(0, Math.floor(x / m.cellW)), row: Math.max(0, Math.floor((y + scrollTop) / m.cellH)) };
}

export function visibleRange(scrollTop: number, viewportH: number, totalRows: number, m: CellMetrics) {
  const first = Math.max(0, Math.floor(scrollTop / m.cellH));
  const last = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportH) / m.cellH));
  return { first, last };
}
```

- [ ] **Step 4: Run tests**

```bash
cd apps/mobile && bun test src/canvasGeometry.test.ts
```
Expected: PASS. (Adjust the `visibleRange` expectation if the pad differs — the assertion documents the intended behavior.)

- [ ] **Step 5: Commit**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/src/canvasGeometry.ts apps/mobile/src/canvasGeometry.test.ts
git commit -m "feat(mobile): pure cell<->pixel geometry for the Skia grid"
```

---

## Task 4: Extract the current `<Text>` renderer into `TerminalView.tsx` (web/desktop)

No behavior change — pure move, so desktop/web stay identical.

**Files:**
- Create: `apps/mobile/src/TerminalView.tsx`
- Modify: `apps/mobile/src/TerminalScreen.tsx`

- [ ] **Step 1: Create the extraction**

Create `apps/mobile/src/TerminalView.tsx` exporting a `TerminalView` component that contains the existing terminal-grid block from `TerminalScreen.tsx` (the `<View style={styles.terminalArea}>` … FlatList … block, lines ~558–651). Props: everything that block reads from `app` (listRef, terminalGrid, panResponder, onScroll, setTermHeight, setTermRect, styles, theme, isDesktop, uploadFile, the tap handlers). Keep the desktop/mobile branches inside exactly as they are.

- [ ] **Step 2: Use it in TerminalScreen**

In `TerminalScreen.tsx`, replace the extracted block with `<TerminalView app={app} />` (pass the single `app` object to minimize prop plumbing). Import `TerminalView` from `./TerminalView`.

- [ ] **Step 3: Verify no behavior change**

```bash
cd apps/mobile && bunx tsc --noEmit && bun test 2>&1 | tail -3
```
Expected: tsc clean, 150+ tests pass. This file resolves for web/desktop; native will override via `TerminalView.native.tsx` (Task 6).

- [ ] **Step 4: Commit**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/src/TerminalView.tsx apps/mobile/src/TerminalScreen.tsx
git commit -m "refactor(mobile): extract terminal render block into TerminalView (web/desktop path)"
```

---

## Task 5: `TerminalCanvas.native.tsx` — static paint of one grid

Paint a `GridSnapshot` with no scroll yet. Prove alignment on device before adding motion.

**Files:**
- Create: `apps/mobile/src/TerminalCanvas.native.tsx`

**Interfaces:**
- Consumes: `getGrid()` (Task 2), `cellMetrics` (Task 3), `PALETTE/DEFAULT_FG/DEFAULT_BG` from `./terminal`, Skia (Task 1).
- Produces: `TerminalCanvas` component taking `{ grid: GridSnapshot; fontSize: number; width: number; height: number; theme }`.

- [ ] **Step 1: Implement the painter**

Create `apps/mobile/src/TerminalCanvas.native.tsx`. Load the monospace font (`matchFont({ fontFamily: 'monospace', fontSize })` — the family confirmed in Phase 0; if a bundled Fira Code TTF is needed, use `useFont(require('<ttf>'), fontSize)`), measure `advance = font.measureText('M').width`, compute `cellMetrics`. Paint per visible cell: bg rect when `bg !== ''` (or when `A_INVERSE`), glyph via `<Text>`/`<Glyphs>` at `(col*cellW, row*cellH + baseline)`, underline/strike as `<Line>`, dim via color alpha, inverse swaps fg/bg (fallback to `DEFAULT_FG/DEFAULT_BG` for `''`). Draw the cursor overlay last. For this task render all `grid.rows` (no windowing) at a fixed offset.

```tsx
import { Canvas, Fill, Rect, Text, matchFont } from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { cellMetrics } from './canvasGeometry';
import { A_INVERSE, A_UNDERLINE, A_STRIKE, A_DIM, type GridSnapshot } from './terminalEngine';
import { DEFAULT_BG, DEFAULT_FG } from './terminal';

export function TerminalCanvas({ grid, fontSize, width, height, theme }: {
  grid: GridSnapshot; fontSize: number; width: number; height: number; theme: { bg: string };
}) {
  const font = useMemo(() => matchFont({ fontFamily: 'monospace', fontSize }), [fontSize]);
  const m = useMemo(() => cellMetrics(font?.measureText('M').width ?? fontSize * 0.6, fontSize), [font, fontSize]);
  const baseline = Math.round(m.cellH * 0.8);
  const nodes: React.ReactNode[] = [];
  for (let r = 0; r < grid.rows.length; r++) {
    const row = grid.rows[r];
    let col = 0;
    for (const cell of row.cells) {
      if (cell.width === 0) continue;
      const inv = (cell.attrs & A_INVERSE) !== 0;
      const fg = (inv ? cell.bg : cell.fg) || (inv ? DEFAULT_BG : DEFAULT_FG);
      const bg = (inv ? cell.fg : cell.bg) || (inv ? DEFAULT_FG : '');
      const x = col * m.cellW;
      const y = r * m.cellH;
      if (bg) nodes.push(<Rect key={`b${r}-${col}`} x={x} y={y} width={m.cellW * cell.width} height={m.cellH} color={bg} />);
      if (cell.char.trim() && font) {
        nodes.push(
          <Text key={`t${r}-${col}`} x={x} y={y + baseline} text={cell.char} font={font}
            color={fg} opacity={cell.attrs & A_DIM ? 0.55 : 1} />,
        );
      }
      col += cell.width;
    }
  }
  // cursor
  if (grid.cursor.visible && font) {
    const cx = grid.cursor.col * m.cellW, cy = grid.cursor.row * m.cellH;
    nodes.push(<Rect key="cursor" x={cx} y={grid.cursor.style === 'underline' ? cy + m.cellH - 2 : cy}
      width={grid.cursor.style === 'bar' ? 2 : m.cellW} height={grid.cursor.style === 'underline' ? 2 : m.cellH}
      color={DEFAULT_FG} opacity={0.6} />);
  }
  return (
    <Canvas style={{ width, height }}>
      <Fill color={theme.bg} />
      {nodes}
    </Canvas>
  );
}
```
(Underline/strike lines omitted here for brevity — add `<Line>` nodes from `A_UNDERLINE`/`A_STRIKE` in the same loop.)

- [ ] **Step 2: On-device static check (Android sim)**

Temporarily mount `TerminalCanvas` in `App.tsx` fed a hand-built grid (a box-drawing row + a CJK row), build+run (Task 1 commands), and confirm columns line up and 你好 spans 2 cells each. Then revert the temporary mount.

- [ ] **Step 3: Commit**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/src/TerminalCanvas.native.tsx
git commit -m "feat(mobile): Skia TerminalCanvas — static cell-grid paint"
```

---

## Task 6: Virtual scroll + cursor blink + tap/link hit-test + wire-in

**Files:**
- Modify: `apps/mobile/src/TerminalCanvas.native.tsx`
- Create: `apps/mobile/src/TerminalView.native.tsx`
- Modify: `apps/mobile/src/useTetherApp.tsx`

**Interfaces:**
- Consumes: `visibleRange`, `pointToCell` (Task 3); `getGrid` (Task 2); existing `cellFromPoint`/`clickSeqs`/`mouseSeq`, `wordAt`, link-open handler.

- [ ] **Step 1: Add windowed paint + scroll to TerminalCanvas**

Add a `scrollTop` state and a `PanResponder` (vertical drag updates `scrollTop`, clamped to `[0, max(0,(rows*cellH)-height)]`; on release apply velocity momentum via a short `requestAnimationFrame` decay). Paint only `visibleRange(scrollTop, height, grid.rows.length, m)` rows, offsetting each row's `y` by `-scrollTop`. Add stick-to-bottom: if `scrollTop` was at max before a new grid arrives, keep it pinned to the new max. Blink the cursor with a `setInterval` toggling opacity, disabled when `reduceMotion`.

- [ ] **Step 2: Add tap + link hit-test**

Wrap the canvas in a `View` with tap handling (reuse the existing double-tap-to-focus / single-tap logic from `TerminalScreen`). On tap compute `{col,row} = pointToCell(x, y, scrollTop, m)`, then:
- If a link span on that row covers `col` → open its target (reuse the existing link-open handler).
- Else if `term.mouseOn` → emit `clickSeqs(col, row, ...)` (existing mouse path).
- Else → focus the hidden keyboard input.
Double-tap a word → `wordAt(rowText, col)` → copy (existing `onCopyWord`).

- [ ] **Step 2b: Feed the grid from useTetherApp on native**

In `useTetherApp.tsx`, the render scheduler currently calls `getSnapshot()`. On native, also expose the latest `getGrid()` result (add `terminalGridSnapshot` state updated in `scheduleRender` alongside the existing snapshot). Keep `getSnapshot()` for the web/desktop path unchanged.

- [ ] **Step 3: Create the native view wrapper**

Create `apps/mobile/src/TerminalView.native.tsx` exporting `TerminalView` that renders `<TerminalCanvas grid={app.terminalGridSnapshot} fontSize={app.fontSize} … />` inside the same container/banner chrome the web `TerminalView` uses (connection banner overlay etc.), so `TerminalScreen` is platform-agnostic.

- [ ] **Step 4: Typecheck + unit tests**

```bash
cd apps/mobile && bunx tsc --noEmit && bun test 2>&1 | tail -3
```
Expected: tsc clean, all tests pass.

- [ ] **Step 5: On-device full smoke (Android sim + iOS)**

Build+run; run `bash tether-engine-test.sh` in a session. Verify: block 4 (box) + block 5 (wide/emoji) **pixel-aligned**; block 11 links — **both** the plain URL and the OSC 8 link now tappable; vim/htop/less aligned; fast scroll smooth; scrollback drag + stick-to-bottom; prompt-jump; reconnect replays with no gaps.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/src/TerminalCanvas.native.tsx apps/mobile/src/TerminalView.native.tsx apps/mobile/src/useTetherApp.tsx
git commit -m "feat(mobile): Skia terminal — virtual scroll, blink, tap/link hit-test, wired in"
```

---

## Task 7: Cleanup + parity pass

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx` (remove now-dead native `<Text>` grid plumbing if unused on native)

- [ ] **Step 1: Confirm no regressions on the shared paths**

```bash
cd apps/mobile && bun test && bunx tsc --noEmit && bunx expo lint 2>&1 | tail -3
```
Expected: tests pass; tsc clean; expo lint problem-count ≤ the pre-Part-2 baseline (record both).

- [ ] **Step 2: Verify OSC 8 link test still passes end-to-end**

```bash
cd apps/mobile && bun test src/terminalGrid.test.ts
```
Expected: PASS (regression guard for the user's URL requirement).

- [ ] **Step 3: Commit + finish**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add -A apps/mobile
git commit -m "chore(mobile): Part 2 cleanup — Skia render parity pass"
```
Then use superpowers:finishing-a-development-branch.

---

## Self-Review

**Spec coverage:**
- Phase-0 Skia build gate (Android+iOS) + font advance + OSC 8 read-back feasibility → Task 1 + Task 2 Step 4. ✓
- `getGrid()` enriched contract (cell width/color/attrs, cursor, baseY) → Task 2. ✓
- Single canvas + virtual scroll → Tasks 5–6. ✓
- Platform split (Skia native, `<Text>` frozen for web/desktop) → Tasks 4 (extract) + 6 (`.native`). ✓
- Links required (regex + OSC 8) tappable → Task 2 (spans) + Task 6 Step 2 (hit-test) + Task 7 Step 2 (guard). ✓
- Reuse links.ts/mouseSeq/wordAt/SelectionView → Task 6. ✓
- Pixel-alignment + perf verification → Task 6 Step 5. ✓

**Placeholder scan:** Underline/strike `<Line>` nodes are described, not fully coded in Task 5 Step 1 (flagged inline) — implementer adds them in the same loop using `A_UNDERLINE`/`A_STRIKE`; acceptable as it's a mechanical repeat of the rect/text pattern. Skia font-family (`'monospace'` vs bundled TTF) is resolved by evidence in Task 1/Task 5. No TBDs.

**Type consistency:** `GridCell/GridRow/GridSnapshot`, `A_*` consts, `cellMetrics/pointToCell/visibleRange` names match across Tasks 2/3/5/6. `getGrid()` return shape matches the Global-Constraints contract. `LinkSpan.target` (`{kind:'external',url}`) matches `links.ts` (from Part 1).

**Open verification points (resolved by evidence in-plan):** resolved skia version + reanimated dependency (Task 1 Step 1); monospace font family/TTF + real advance (Task 1 Step 2, Task 5 Step 1); OSC 8 span end-column semantics for BEL vs ST terminators (Task 2 Step 5).
