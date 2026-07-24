# Terminal Engine Parser Swap (@xterm/headless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled `TerminalEmulator` VT parser with `@xterm/headless` behind an adapter that keeps the exact `RenderRow[]` contract, so the render layer and all callers are unchanged.

**Architecture:** New `terminalEngine.ts` wraps a headless xterm `Terminal` and exposes the same public surface `TerminalEmulator` has today (drop-in). It reads `term.buffer.active` to build `RenderRow[]` (runs of styled text) with row-object reuse for `React.memo`. All custom features (OSC 133 prompt marks, OSC 7 cwd, OSC 777/99 notifications, OSC 52 clipboard, mouse modes, DECSCUSR cursor style, bell, title) are ported to xterm parser hooks. A `navigator` shim (required — Phase 0 finding) loads before xterm.

**Tech Stack:** Bun + TypeScript, Expo 57 / RN 0.86 / Hermes, `@xterm/headless@6.0.0`, `bun test`, Biome.

## Global Constraints

- Runtime floor: **Bun ≥ 1.3.14** (server PTY); mobile is Expo **57.0.7** — do NOT bump Expo past 57.0.7 (jsi Swift patch pinned).
- **`navigator` shim is mandatory**: `@xterm/headless@6.0.0` reads `navigator.userAgent.includes(...)` at import; RN's is `undefined` → crash. Shim must be the FIRST import in `apps/mobile/index.ts`.
- Dependency: **`@xterm/headless@6.0.0`** exactly (the version proven on Hermes in Phase 0).
- The `RenderRow` / `CellStyle` contract in `apps/mobile/src/terminal.ts` stays **byte-for-byte compatible** for Part 1. No `Cell[]` grid yet (that is Part 2 / Skia).
- Formatting: Biome — 2-space indent, single quotes, semicolons, trailing commas, width 100. Run `bun format` before each commit.
- Tests: `bun test` from `apps/mobile`. Test files use `bun:test` (`import { test, expect, describe } from 'bun:test'` — existing files rely on globals; match the existing file's style).
- All work is in `apps/mobile`. Server (`apps/server`) is untouched.

### Drop-in API the adapter MUST expose (verbatim from `TerminalEmulator`)

```ts
class TerminalEngine {
  constructor(cols?: number, rows?: number);         // default 80x24
  cols: number; rows: number;                          // current size (getters ok)
  write(data: string): void;
  resize(cols: number, rows: number): void;
  reset(): void;
  getSnapshot(): RenderRow[];                          // with row-object reuse
  jumpToPrompt(fromRow: number, dir: 1 | -1): number | null;

  // live-read fields (mutated as bytes arrive)
  bellCount: number;
  notifyCount: number;
  lastNotify: { title: string; body: string };
  promptReturnCount: number;
  title: string;
  cwd: string;
  applicationCursor: boolean;
  bracketedPaste: boolean;
  cursorStyle: 'block' | 'bar' | 'underline';
  mouseMode: 'off' | 'x10' | 'normal' | 'button' | 'any';
  mouseSgr: boolean;
  get mouseOn(): boolean;                               // mouseMode !== 'off'

  // callbacks
  onReply: ((data: string) => void) | null;            // auto-replies (DSR/DA) + xterm onData
  onClipboardWrite: ((text: string) => void) | null;   // OSC 52
}
```

`RenderRow` (unchanged): `{ key: number; runs: {text: string; style: CellStyle}[]; wrapped: boolean; links: LinkSpan[]; promptStart: boolean }`.

---

## File Structure

- **Create** `apps/mobile/src/xtermPolyfill.ts` — navigator shim (3 lines).
- **Create** `apps/mobile/src/terminalEngine.ts` — the adapter (the new engine).
- **Create** `apps/mobile/src/terminalEngine.test.ts` — conformance suite (byte seq → snapshot/fields).
- **Modify** `apps/mobile/index.ts` — add `import './xtermPolyfill';` as first line.
- **Modify** `apps/mobile/src/useTetherApp.tsx` — swap `TerminalEmulator` → `TerminalEngine`; wire `onData`.
- **Keep** `apps/mobile/src/terminal.ts` **types only** (`RenderRow`, `CellStyle`, `MouseMode`, `setTheme`, `Theme`, the 256-color palette) — move the class out, keep exports the rest of the app imports.
- **Delete (end)** the `TerminalEmulator` class body + `terminal.parser.test.ts` once the suite passes.
- **Keep** `links.ts`, `mouseSeq.ts`, `mouseInput.ts`, `TermRow.tsx`, `TerminalScreen.tsx` — unchanged.

---

## Task 1: Navigator shim + dependency, prove import under test

**Files:**
- Create: `apps/mobile/src/xtermPolyfill.ts`
- Modify: `apps/mobile/index.ts:1`
- Modify: `apps/mobile/package.json` (dep)
- Test: `apps/mobile/src/terminalEngine.test.ts`

**Interfaces:**
- Produces: side-effect import `./xtermPolyfill`; availability of `@xterm/headless`.

- [ ] **Step 1: Install the exact dependency**

```bash
cd apps/mobile && bun add @xterm/headless@6.0.0
```

- [ ] **Step 2: Create the shim**

Create `apps/mobile/src/xtermPolyfill.ts`:

```ts
// @xterm/headless 6.0.0 platform-detection reads navigator.userAgent.includes()
// / navigator.platform at import time. Under Hermes those are undefined -> crash.
// Provide string stubs BEFORE xterm is imported. Must be the FIRST import in index.ts.
const nav = (globalThis as any).navigator ?? ((globalThis as any).navigator = {});
if (typeof nav.userAgent !== 'string') nav.userAgent = 'ReactNative';
if (typeof nav.platform !== 'string') nav.platform = 'ReactNative';
```

- [ ] **Step 3: Wire the shim first in the entry**

Modify `apps/mobile/index.ts` — add as the very first line, above `import { registerRootComponent } from 'expo';`:

```ts
import './xtermPolyfill';
```

- [ ] **Step 4: Write the failing import test**

Create `apps/mobile/src/terminalEngine.test.ts`:

```ts
import { expect, test } from 'bun:test';
import './xtermPolyfill';
import { Terminal } from '@xterm/headless';

test('xterm headless imports and writes under the shim', () => {
  const t = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  t.write('hi');
  // write is async-flushed; force a sync read after microtask via writeSync-like drain:
  t.write('', () => {
    expect(t.buffer.active.getLine(0)?.translateToString(true)).toContain('hi');
  });
  expect(t.cols).toBe(20);
});
```

- [ ] **Step 5: Run it**

```bash
cd apps/mobile && bun test src/terminalEngine.test.ts
```
Expected: PASS (import works, `t.cols === 20`). If it throws `Cannot read property 'includes' of undefined`, the shim import order is wrong — the `./xtermPolyfill` import must precede the `@xterm/headless` import in the file.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/src/xtermPolyfill.ts apps/mobile/index.ts apps/mobile/package.json apps/mobile/src/terminalEngine.test.ts bun.lock
git commit -m "feat(mobile): add @xterm/headless + navigator shim for Hermes"
```

---

## Task 2: Core adapter — write/resize/reset/size + text+SGR snapshot

Builds the engine skeleton and the `getSnapshot()` text+color path. Wide-char width and cursor caret included. No scrollback keys/links/modes/OSC yet (later tasks).

**Files:**
- Create: `apps/mobile/src/terminalEngine.ts`
- Test: `apps/mobile/src/terminalEngine.test.ts`

**Interfaces:**
- Consumes: `RenderRow`, `CellStyle` from `./terminal`; the 256-palette. (If the palette is not exported, export it from `terminal.ts` in Step 1.)
- Produces: `class TerminalEngine` with `constructor/cols/rows/write/resize/reset/getSnapshot` (partial).

- [ ] **Step 1: Export the palette + defaults from terminal.ts**

In `apps/mobile/src/terminal.ts`, add `export` to the 256-color palette array and the default fg/bg so the adapter reuses the exact same colors. Find the palette (the `pal`/`PALETTE` array built near the top) and the `DEFAULT_FG`/`DEFAULT_BG` lets; change to:

```ts
export const PALETTE_256: string[] = /* existing palette build */;
export let DEFAULT_FG = APP_THEMES.mocha.terminal.fg;
export let DEFAULT_BG = APP_THEMES.mocha.terminal.bg;
```
(Keep `setTheme` mutating `DEFAULT_FG`/`DEFAULT_BG` as today.)

- [ ] **Step 2: Write failing tests for text, SGR color, wide char**

Append to `apps/mobile/src/terminalEngine.test.ts`:

```ts
import { TerminalEngine } from './terminalEngine';

const E = '\x1b';
function rowText(t: TerminalEngine, i: number): string {
  return t.getSnapshot()[i].runs.map((r) => r.text).join('').replace(/\s+$/, '');
}

test('plain text lands on row 0', () => {
  const t = new TerminalEngine(20, 5);
  t.write('hello');
  expect(rowText(t, 0)).toBe('hello');
});

test('truecolor SGR sets run fg', () => {
  const t = new TerminalEngine(20, 5);
  t.write(`${E}[38;2;255;0;0mR${E}[0m`);
  const runs = t.getSnapshot()[0].runs.filter((r) => r.text.trim() !== '');
  expect(runs[0].text).toBe('R');
  expect(runs[0].style.fg?.toLowerCase()).toBe('#ff0000');
});

test('bold + wide char occupy correct columns', () => {
  const t = new TerminalEngine(20, 5);
  t.write(`${E}[1mAB${E}[0m你`);
  const s = t.getSnapshot()[0];
  const text = s.runs.map((r) => r.text).join('');
  // 你 is a 2-cell wide char; ensure it appears once and columns are consistent
  expect(text.startsWith('AB你')).toBe(true);
  expect(s.runs.find((r) => r.text.includes('A'))?.style.bold).toBe(true);
});
```

- [ ] **Step 3: Run — expect failure**

```bash
cd apps/mobile && bun test src/terminalEngine.test.ts
```
Expected: FAIL — `TerminalEngine` not exported.

- [ ] **Step 4: Implement the core adapter**

Create `apps/mobile/src/terminalEngine.ts`:

```ts
import './xtermPolyfill';
import { Terminal } from '@xterm/headless';
import type { IBufferCell, IBufferLine } from '@xterm/headless';
import {
  type CellStyle,
  DEFAULT_BG,
  DEFAULT_FG,
  PALETTE_256,
  type RenderRow,
} from './terminal';

const MAX_SCROLLBACK = 1000;

// Map an xterm cell's fg/bg to a hex string using the app palette/theme.
function fgOf(cell: IBufferCell): string | undefined {
  if (cell.isFgDefault()) return undefined; // renderer falls back to DEFAULT_FG
  if (cell.isFgRGB()) {
    const n = cell.getFgColor();
    return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  if (cell.isFgPalette()) return PALETTE_256[cell.getFgColor()] ?? undefined;
  return undefined;
}
function bgOf(cell: IBufferCell): string | undefined {
  if (cell.isBgDefault()) return undefined;
  if (cell.isBgRGB()) {
    const n = cell.getBgColor();
    return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  if (cell.isBgPalette()) return PALETTE_256[cell.getBgColor()] ?? undefined;
  return undefined;
}

function styleOf(cell: IBufferCell, caret: boolean): CellStyle {
  const s: CellStyle = {};
  const fg = fgOf(cell);
  const bg = bgOf(cell);
  if (fg) s.fg = fg;
  if (bg) s.bg = bg;
  if (cell.isBold()) s.bold = true;
  if (cell.isDim()) s.dim = true;
  if (cell.isItalic()) s.italic = true;
  if (cell.isUnderline()) s.underline = true;
  if (cell.isStrikethrough()) s.strike = true;
  if (cell.isInverse()) s.inverse = true;
  if (caret) s.caret = true;
  return s;
}

function styleEq(a: CellStyle, b: CellStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    !!a.inverse === !!b.inverse &&
    !!a.caret === !!b.caret
  );
}

export class TerminalEngine {
  private term: Terminal;
  private cell: IBufferCell | undefined;

  bellCount = 0;
  notifyCount = 0;
  lastNotify = { title: '', body: '' };
  promptReturnCount = 0;
  title = '';
  cwd = '';
  applicationCursor = false;
  bracketedPaste = false;
  cursorStyle: 'block' | 'bar' | 'underline' = 'block';
  mouseMode: 'off' | 'x10' | 'normal' | 'button' | 'any' = 'off';
  mouseSgr = false;
  onReply: ((data: string) => void) | null = null;
  onClipboardWrite: ((text: string) => void) | null = null;

  get mouseOn(): boolean {
    return this.mouseMode !== 'off';
  }

  constructor(cols = 80, rows = 24) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: MAX_SCROLLBACK,
      allowProposedApi: true,
    });
    // xterm emits generated replies (DSR/DA) AND nothing else here (user input is
    // sent by the app, not the emulator). Forward replies to onReply.
    this.term.onData((d) => this.onReply?.(d));
  }

  get cols(): number {
    return this.term.cols;
  }
  get rows(): number {
    return this.term.rows;
  }

  write(data: string): void {
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(Math.max(1, cols), Math.max(1, rows));
  }

  reset(): void {
    this.term.reset();
    this.bellCount = 0;
    this.notifyCount = 0;
    this.lastNotify = { title: '', body: '' };
    this.promptReturnCount = 0;
    this.title = '';
    this.cwd = '';
    this.applicationCursor = false;
    this.bracketedPaste = false;
    this.cursorStyle = 'block';
    this.mouseMode = 'off';
    this.mouseSgr = false;
    this.prevRows = [];
  }

  private prevRows: RenderRow[] = [];

  getSnapshot(): RenderRow[] {
    const buf = this.term.buffer.active;
    const total = buf.length; // scrollback + viewport lines with content
    const cursorAbs = buf.baseY + buf.cursorY;
    const out: RenderRow[] = new Array(total);
    for (let y = 0; y < total; y++) {
      const line = buf.getLine(y);
      if (!line) {
        out[y] = { key: y, runs: [{ text: '', style: {} }], wrapped: false, links: [], promptStart: false };
        continue;
      }
      const caretCol = y === cursorAbs && this.term.buffer.active === buf ? buf.cursorX : -1;
      const runs = this.runsFor(line, caretCol);
      const wrapped = line.isWrapped;
      const key = y; // absolute line index — stable while not trimmed (see Task 3)
      const prev = this.prevRows[y];
      out[y] =
        prev && prev.key === key && prev.wrapped === wrapped && runsEqual(prev.runs, runs)
          ? prev
          : { key, runs, wrapped, links: [], promptStart: false };
    }
    this.prevRows = out;
    return out;
  }

  private runsFor(line: IBufferLine, caretCol: number): RenderRow['runs'] {
    const runs: RenderRow['runs'] = [];
    let cur: { text: string; style: CellStyle } | null = null;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, this.cell);
      this.cell = cell;
      if (!cell) continue;
      const w = cell.getWidth();
      if (w === 0) continue; // trailing cell of a wide char — already included
      const chars = cell.getChars() || ' ';
      const style = styleOf(cell, x === caretCol);
      if (cur && styleEq(cur.style, style)) {
        cur.text += chars;
      } else {
        cur = { text: chars, style };
        runs.push(cur);
      }
    }
    if (runs.length === 0) runs.push({ text: '', style: {} });
    return runs;
  }

  jumpToPrompt(_fromRow: number, _dir: 1 | -1): number | null {
    return null; // implemented in Task 3
  }
}

function runsEqual(a: RenderRow['runs'], b: RenderRow['runs']): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || !styleEq(a[i].style, b[i].style)) return false;
  }
  return true;
}
```

- [ ] **Step 5: Run tests**

```bash
cd apps/mobile && bun test src/terminalEngine.test.ts
```
Expected: PASS for text, truecolor, bold+wide. If the wide-char test fails on `startsWith('AB你')`, verify the `w === 0` skip is dropping the spacer cell (xterm puts width 0 on the cell after a wide glyph).

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/src/terminalEngine.ts apps/mobile/src/terminalEngine.test.ts apps/mobile/src/terminal.ts
git commit -m "feat(mobile): TerminalEngine core — text + SGR + wide-char snapshot"
```

---

## Task 3: Scrollback-stable keys, wrapped rejoin, links, prompt jump

Makes `key` survive lines entering scrollback (FlatList identity), fills `links`, `promptStart`, and implements `jumpToPrompt`.

**Files:**
- Modify: `apps/mobile/src/terminalEngine.ts`
- Test: `apps/mobile/src/terminalEngine.test.ts`

**Interfaces:**
- Consumes: `computeLinkSpans`, `explicitLinkSpans`-equivalent from `./links`; `registerMarker`.
- Produces: stable `RenderRow.key`, populated `links`/`promptStart`, working `jumpToPrompt`.

- [ ] **Step 1: Write failing tests**

Append:

```ts
test('row key is stable when a line scrolls into scrollback', () => {
  const t = new TerminalEngine(20, 2); // 2 visible rows
  t.write('one\r\n');
  const key1 = t.getSnapshot().find((r) => r.runs.map((x) => x.text).join('').includes('one'))!.key;
  t.write('two\r\nthree\r\n'); // pushes 'one' into scrollback
  const key2 = t.getSnapshot().find((r) => r.runs.map((x) => x.text).join('').includes('one'))!.key;
  expect(key2).toBe(key1);
});

test('URL produces a link span', () => {
  const t = new TerminalEngine(60, 3);
  t.write('see https://example.com now');
  const row = t.getSnapshot()[0];
  expect(row.links.length).toBeGreaterThan(0);
  expect(row.links[0].url).toBe('https://example.com');
});

test('OSC 133;A marks promptStart and jumpToPrompt finds it', () => {
  const t = new TerminalEngine(20, 4);
  t.write('\x1b]133;A\x07$ cmd\r\nout\r\n');
  const snap = t.getSnapshot();
  const promptRow = snap.findIndex((r) => r.promptStart);
  expect(promptRow).toBeGreaterThanOrEqual(0);
  expect(t.jumpToPrompt(snap.length - 1, -1)).toBe(promptRow);
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd apps/mobile && bun test src/terminalEngine.test.ts
```
Expected: FAIL (keys shift, links empty, promptStart false).

- [ ] **Step 3: Implement stable keys via a monotonic line id**

xterm reuses/rotates internal line objects, and absolute index shifts when scrollback trims. Track a monotonic id per absolute line using the trim event. In `terminalEngine.ts`:

- Add fields: `private lineIdBase = 0;` (id of absolute row 0) and hook trim:

```ts
// in constructor, after creating term:
this.term.buffer.active.trimEnd; // no-op ref
this.term.onLineFeed(() => { /* ids handled lazily in getSnapshot */ });
```

Replace `const key = y;` in `getSnapshot` with an id that accounts for trimmed lines. xterm exposes trimmed count via the `onScroll`/buffer; simplest robust approach: maintain a running total of lines ever trimmed.

```ts
// field:
private trimmed = 0;
// in constructor:
this.term.parser; // ensure init
this.term.buffer.active;
this.term.onScroll(() => {}); // keep reference; trims tracked below
// Track trims: when scrollback is full and a line is pushed, baseY stops growing.
```

Use the documented signal: `buffer.baseY` grows until scrollback cap, then stays; the number of trimmed lines = `(totalLinesWritten - buffer.length)`. Track `totalLinesWritten` via `onLineFeed`:

```ts
// field:
private fed = 0;
// constructor:
this.term.onLineFeed(() => { this.fed++; });
// getSnapshot: absolute-stable id
const trimmedLines = Math.max(0, this.fed + this.term.rows - this.term.buffer.active.length);
const key = trimmedLines + y;
```

- [ ] **Step 4: Implement links + promptStart**

Add a prompt-row marker set and OSC 133 handler in the constructor:

```ts
// field:
private promptMarkers = new Set<number>(); // absolute line ids
// constructor:
this.term.parser.registerOscHandler(133, (data) => {
  if (data.startsWith('A')) {
    const abs = this.absCursorId();
    this.promptMarkers.add(abs);
  }
  if (data.startsWith('D')) this.promptReturnCount++;
  return false; // let xterm continue default handling
});
```

Add helper + wire into snapshot:

```ts
private absCursorId(): number {
  const buf = this.term.buffer.active;
  const trimmedLines = Math.max(0, this.fed + this.term.rows - buf.length);
  return trimmedLines + buf.baseY + buf.cursorY;
}
```

In `getSnapshot`, after building `runs` for all rows, compute links over the full text set (rejoining soft-wrapped rows) using the existing `links.ts`:

```ts
import { computeLinkSpans } from './links';
// after the row loop builds `out` with text:
const texts = out.map((r) => r.runs.map((x) => x.text).join(''));
const wrappedFlags = out.map((r) => r.wrapped);
const spans = computeLinkSpans(texts, wrappedFlags);
for (let y = 0; y < out.length; y++) {
  const promptStart = this.promptMarkers.has(trimmedLines + y);
  if (!out[y].links.length && spans[y]?.length) {
    out[y] = { ...out[y], links: spans[y], promptStart };
  } else if (out[y].promptStart !== promptStart) {
    out[y] = { ...out[y], promptStart };
  }
}
```
(Keep the reuse optimization: only clone a row when its links/promptStart actually change.)

- [ ] **Step 5: Implement jumpToPrompt over the snapshot**

```ts
jumpToPrompt(fromRow: number, dir: 1 | -1): number | null {
  const snap = this.prevRows.length ? this.prevRows : this.getSnapshot();
  for (let i = fromRow + dir; i >= 0 && i < snap.length; i += dir) {
    if (snap[i].promptStart) return i;
  }
  return null;
}
```

- [ ] **Step 6: Run tests**

```bash
cd apps/mobile && bun test src/terminalEngine.test.ts
```
Expected: PASS (stable key, link span, promptStart + jump). If the key test still shifts, log `this.fed`, `buffer.baseY`, `buffer.length` and reconcile the `trimmedLines` formula against observed values.

- [ ] **Step 7: Commit**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/src/terminalEngine.ts apps/mobile/src/terminalEngine.test.ts
git commit -m "feat(mobile): TerminalEngine stable keys, links, OSC-133 prompt jump"
```

---

## Task 4: Modes — app cursor, bracketed paste, cursor style, mouse

**Files:**
- Modify: `apps/mobile/src/terminalEngine.ts`
- Test: `apps/mobile/src/terminalEngine.test.ts`

**Interfaces:**
- Produces: live `applicationCursor`, `bracketedPaste`, `cursorStyle`, `mouseMode`, `mouseSgr`, `mouseOn`.

- [ ] **Step 1: Write failing tests**

```ts
test('DECCKM sets applicationCursor', () => {
  const t = new TerminalEngine(20, 4);
  t.write('\x1b[?1h');
  expect(t.applicationCursor).toBe(true);
  t.write('\x1b[?1l');
  expect(t.applicationCursor).toBe(false);
});

test('bracketed paste mode 2004', () => {
  const t = new TerminalEngine(20, 4);
  t.write('\x1b[?2004h');
  expect(t.bracketedPaste).toBe(true);
});

test('SGR mouse mode 1006 + 1000', () => {
  const t = new TerminalEngine(20, 4);
  t.write('\x1b[?1000h\x1b[?1006h');
  expect(t.mouseOn).toBe(true);
  expect(t.mouseMode).toBe('normal');
  expect(t.mouseSgr).toBe(true);
});

test('DECSCUSR cursor style bar (6) then block (2)', () => {
  const t = new TerminalEngine(20, 4);
  t.write('\x1b[6 q');
  expect(t.cursorStyle).toBe('bar');
  t.write('\x1b[2 q');
  expect(t.cursorStyle).toBe('block');
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd apps/mobile && bun test src/terminalEngine.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement modes by reading xterm state after each write**

xterm tracks these internally (`term.modes`). After each `write`, refresh the mirror fields. Add a private `syncModes()` called at the end of `write` (xterm processes synchronously enough for tests; for live use, also call in `getSnapshot`).

```ts
private syncModes(): void {
  const m = this.term.modes;
  this.applicationCursor = m.applicationCursorKeysMode;
  this.bracketedPaste = m.bracketedPasteMode;
  // mouse
  switch (m.mouseTrackingMode) {
    case 'none': this.mouseMode = 'off'; break;
    case 'x10': this.mouseMode = 'x10'; break;
    case 'vt200': this.mouseMode = 'normal'; break;
    case 'drag': this.mouseMode = 'button'; break;
    case 'any': this.mouseMode = 'any'; break;
    default: this.mouseMode = 'off';
  }
  this.mouseSgr = m.mouseEncoding === 'SGR';
}
```

Update `write`:

```ts
write(data: string): void {
  this.term.write(data);
  this.syncModes();
}
```

Cursor style: xterm does not expose DECSCUSR via `modes`, so register a CSI handler for the `SP q` sequence in the constructor:

```ts
this.term.parser.registerCsiHandler({ final: 'q', intermediates: ' ' }, (params) => {
  const p = params[0] ?? 1;
  this.cursorStyle = p === 6 || p === 5 ? 'bar' : p === 3 || p === 4 ? 'underline' : 'block';
  return false; // allow xterm's own handling to proceed
});
```

- [ ] **Step 4: Run tests**

```bash
cd apps/mobile && bun test src/terminalEngine.test.ts
```
Expected: PASS. If `term.modes` field names differ in 6.0.0, inspect with `console.log(Object.keys(t.modes))` and adjust the mapping (the values are the public `IModes` interface).

- [ ] **Step 5: Commit**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/src/terminalEngine.ts apps/mobile/src/terminalEngine.test.ts
git commit -m "feat(mobile): TerminalEngine modes — cursor keys, bracketed paste, mouse, DECSCUSR"
```

---

## Task 5: OSC features — title, cwd, notifications, clipboard, bell

Ports OSC 0/2 (title), OSC 7 (cwd), OSC 777 + kitty OSC 99 (notify), OSC 52 (clipboard), and bell.

**Files:**
- Modify: `apps/mobile/src/terminalEngine.ts`
- Test: `apps/mobile/src/terminalEngine.test.ts`

**Interfaces:**
- Produces: live `title`, `cwd`, `bellCount`, `notifyCount`, `lastNotify`; `onClipboardWrite` fires on OSC 52.

- [ ] **Step 1: Write failing tests**

```ts
test('OSC 2 sets title, OSC 7 sets cwd', () => {
  const t = new TerminalEngine(20, 4);
  t.write('\x1b]2;My Title\x07');
  expect(t.title).toBe('My Title');
  t.write('\x1b]7;file://host/home/sam\x07');
  expect(t.cwd).toBe('/home/sam');
});

test('bell increments bellCount', () => {
  const t = new TerminalEngine(20, 4);
  t.write('\x07');
  expect(t.bellCount).toBe(1);
});

test('OSC 777 notify sets lastNotify + count', () => {
  const t = new TerminalEngine(20, 4);
  t.write('\x1b]777;notify;Build done;All green\x07');
  expect(t.notifyCount).toBe(1);
  expect(t.lastNotify).toEqual({ title: 'Build done', body: 'All green' });
});

test('OSC 52 fires onClipboardWrite with decoded text', () => {
  const t = new TerminalEngine(20, 4);
  let got = '';
  t.onClipboardWrite = (s) => { got = s; };
  const b64 = Buffer.from('copied').toString('base64');
  t.write(`\x1b]52;c;${b64}\x07`);
  expect(got).toBe('copied');
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd apps/mobile && bun test src/terminalEngine.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement title/bell via xterm events, OSC handlers for the rest**

In the constructor:

```ts
this.term.onTitleChange((t2) => { this.title = t2; });
this.term.onBell(() => { this.bellCount++; });

// OSC 7 — cwd (file://host/path)
this.term.parser.registerOscHandler(7, (data) => {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (m) {
    try { this.cwd = decodeURIComponent(m[1]); } catch { this.cwd = m[1]; }
  }
  return true;
});

// OSC 777 — rxvt/ghostty notify;title;body
this.term.parser.registerOscHandler(777, (data) => {
  const parts = data.split(';');
  if (parts[0] === 'notify') {
    this.lastNotify = { title: parts[1] ?? '', body: parts[2] ?? '' };
    this.notifyCount++;
  }
  return true;
});

// OSC 99 — kitty desktop notification (d=payload segments; p=title|body)
this.term.parser.registerOscHandler(99, (data) => {
  // minimal: treat the body after the last ';' as text; full spec handled as today
  const idx = data.indexOf(';');
  const body = idx >= 0 ? data.slice(idx + 1) : data;
  if (body) {
    this.lastNotify = { title: body, body: '' };
    this.notifyCount++;
  }
  return true;
});

// OSC 52 — clipboard (selector;base64)
this.term.parser.registerOscHandler(52, (data) => {
  const semi = data.indexOf(';');
  const payload = semi >= 0 ? data.slice(semi + 1) : data;
  if (payload && payload !== '?') {
    try {
      const text =
        typeof atob === 'function'
          ? decodeURIComponent(escape(atob(payload)))
          : Buffer.from(payload, 'base64').toString('utf8');
      this.onClipboardWrite?.(text);
    } catch {
      /* ignore malformed base64 */
    }
  }
  return true;
});
```

> Note: match the exact OSC 99 kitty parsing that `terminal.ts` does today (see its `raiseNotify` / kitty path). Copy that field parsing verbatim rather than the minimal version above if the current behavior is richer — check `apps/mobile/src/terminal.ts` around the `kittyNotif`/`raiseNotify` code and replicate it.

- [ ] **Step 4: Run tests**

```bash
cd apps/mobile && bun test src/terminalEngine.test.ts
```
Expected: PASS.

- [ ] **Step 5: Port the FULL existing conformance suite**

Copy the meaningful assertions from `apps/mobile/src/terminal.test.ts` into `terminalEngine.test.ts`, retargeting `new TerminalEmulator(...)` → `new TerminalEngine(...)` and the `line()/screenText()` helpers to read `getSnapshot()`. Run:

```bash
cd apps/mobile && bun test src/terminalEngine.test.ts
```
Expected: PASS. For any assertion that fails because xterm's (correct) behavior differs from the old subset emulator's, update the expectation to the xterm-correct value and add a one-line comment `// xterm-correct: was <old>`.

- [ ] **Step 6: Commit**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile run format
git add apps/mobile/src/terminalEngine.ts apps/mobile/src/terminalEngine.test.ts
git commit -m "feat(mobile): TerminalEngine OSC — title, cwd, notify, clipboard, bell + full conformance suite"
```

---

## Task 6: Swap into the app, delete old parser, on-device smoke

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx` (import + `new` sites + onData wiring)
- Modify: `apps/mobile/src/terminal.ts` (remove `TerminalEmulator` class, keep types/palette/setTheme)
- Delete: `apps/mobile/src/terminal.parser.test.ts`

**Interfaces:**
- Consumes: `TerminalEngine` (Tasks 2–5), drop-in for `TerminalEmulator`.

- [ ] **Step 1: Swap the import and constructor**

In `apps/mobile/src/useTetherApp.tsx`:
- Line ~74: change `import { type CellStyle, type RenderRow, setTheme, TerminalEmulator } from './terminal';` → `import { type CellStyle, type RenderRow, setTheme } from './terminal';` and add `import { TerminalEngine } from './terminalEngine';`
- Line ~434: `new TerminalEmulator(numCols || 80, numRows || 24)` → `new TerminalEngine(numCols || 80, numRows || 24)`.

- [ ] **Step 2: Wire onData → PTY input (replies)**

The old emulator only emitted `onReply` for auto-generated query responses; user keystrokes are sent separately by the app. xterm routes both through `onData`, but since the app never calls `term.onData`-triggering input methods (it only `write()`s server output), `onData` here still only fires for auto-replies (DSR/DA/etc.). The adapter already forwards `onData → onReply`. Confirm the existing `onReply` assignment site still works: search and keep it.

```bash
cd apps/mobile && grep -n "onReply" src/useTetherApp.tsx
```
Expected: the assignment `term.onReply = (data) => wsSend(...)` (or similar) is intact and now receives xterm replies. No change needed beyond confirming it compiles.

- [ ] **Step 3: Typecheck**

```bash
cd /home/samuelloranger/sites/tether && bun --cwd apps/mobile exec tsc --noEmit
```
Expected: no errors. Fix any field/method mismatches against the drop-in contract.

- [ ] **Step 4: Run the whole mobile test suite**

```bash
cd apps/mobile && bun test
```
Expected: PASS (all files, including the ported conformance suite).

- [ ] **Step 5: On-device smoke on the Android sim**

```bash
export ANDROID_HOME=/home/samuelloranger/Android/Sdk QT_QPA_PLATFORM=offscreen
$ANDROID_HOME/emulator/emulator -avd tether_test -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect &
# wait for boot: adb wait-for-device; adb shell getprop sys.boot_completed == 1
cd apps/mobile && bun x expo run:android
```
Then in the app: connect to a tether server, run `vim`, `htop`, and `claude`; confirm alignment, colors, cursor, prompt-jump, links, and no crash. Package: `com.samuelloranger.tethermobile`. JS reload via Metro (`adb reverse tcp:8081 tcp:8081`).

- [ ] **Step 6: Delete the old parser**

Remove the `TerminalEmulator` class from `apps/mobile/src/terminal.ts` (keep `RenderRow`, `CellStyle`, `MouseMode`, `Theme`, `setTheme`, `PALETTE_256`, `DEFAULT_FG/BG`). Delete `apps/mobile/src/terminal.parser.test.ts`.

```bash
cd apps/mobile && bun test && bun --cwd . exec tsc --noEmit
```
Expected: PASS (nothing imports the removed class).

- [ ] **Step 7: Lint + commit**

```bash
cd /home/samuelloranger/sites/tether && bun lint && bun --cwd apps/mobile run format
git add apps/mobile/src/useTetherApp.tsx apps/mobile/src/terminal.ts
git rm apps/mobile/src/terminal.parser.test.ts
git commit -m "feat(mobile): swap TerminalEmulator -> TerminalEngine (@xterm/headless), drop old parser"
```

---

## Self-Review

**Spec coverage:**
- Navigator shim → Task 1. ✓
- `terminalEngine.ts` adapter + drop-in API → Tasks 2–5, wired in Task 6. ✓
- Feature port map (SGR/256/truecolor, wide char, OSC 133, links, mouse, bell/title/resize, scrollback cap, stable key) → Tasks 2–5. ✓
- Change detection / row reuse → Task 2 (`prevRows`, `runsEqual`) + Task 3 (clone-on-change for links/prompt). ✓
- Conformance suite as safety net (repurpose `terminal.test.ts`) → Task 5 Step 5. ✓
- Delete old parser + `terminal.parser.test.ts` → Task 6. ✓
- Keep `links.ts`/`mouseSeq.ts`/render → untouched. ✓
- On-device smoke → Task 6 Step 5. ✓

**Placeholder scan:** OSC 99 kitty parsing is flagged to copy verbatim from current `terminal.ts` (Task 5 Step 3 note) rather than left vague — implementer must read the existing `raiseNotify`/kitty code. `cwd`/`notify` regex are concrete. No TBDs.

**Type consistency:** `TerminalEngine` fields/methods match the Global-Constraints drop-in block. `RenderRow` shape unchanged. `styleOf`/`styleEq`/`runsEqual` names consistent across tasks. `mouseMode` union matches `MouseMode` in `terminal.ts`.

**Open verification points for the implementer** (xterm 6.0.0 API names to confirm at build time, each with a fallback noted in-task): `term.modes` field names (Task 4 Step 4), wide-char width-0 spacer skip (Task 2 Step 5), trimmed-line id formula (Task 3 Step 6).
