# Terminal Engine Overhaul — Part 1: Parser swap to `@xterm/headless`

**Date:** 2026-07-24
**Status:** Design — pending user review
**Board:** task #368
**Scope:** Phase 0 (feasibility, DONE) + Subproject 1 (parser swap). The Skia render swap is Part 2, a separate spec written after this ships.

## Problem

The mobile terminal engine is a hand-rolled VT emulator: `apps/mobile/src/terminal.ts` (1265 loc, `TerminalEmulator` class). It is a deliberate "common subset" of xterm — its own header says *"upgrade to xterm-headless if a TUI needs modes not handled here."* In practice it is a constant source of correctness gaps, missing features, and maintenance burden: every TUI that uses a mode we didn't implement renders wrong, and wide characters (CJK/emoji) are mismeasured because the render path fakes column width.

The engine has two independent layers, joined by one seam (`RenderRow[]`):

```
PTY bytes → TerminalEmulator (parser) → RenderRow[] → TermRow / <Text> (render)
```

This spec replaces the **parser** only. The render layer keeps working unchanged against the same seam, so exactly one variable changes: if a TUI regresses, it is the parser. The render swap (→ Skia cell grid) is Part 2.

### Why not libghostty

The original idea was to wrap libghostty. Ruled out: libghostty is Zig with a young, **surface-oriented** C API (you hand it a Metal/OpenGL context; it owns rendering + input). It is not a headless "feed bytes → read a cell grid" library. Embedding it means a Zig static lib + C→JSI native module hosting a Metal layer in an RN view — **iOS-only**, no Android RN, no reuse in the Tauri desktop (Rust+webview), impossible on the web build. It would fragment the single shared core and *raise* maintenance — the opposite of the goal. `@xterm/headless` is pure JS and keeps one core across mobile + desktop + web.

### Non-goal: identity

The VT parser and glyph painter are plumbing every terminal shares; they are not Tether's differentiators. Persistent PTY surviving disconnect + SQLite replay/reconnect, phone-first multi-terminal drawer tabs, OSC-133 prompt jump, presentations/preview, in-app diff/git, notifications, snippets, file drop — none of that is touched. This swap deletes a VT-conformance tax that buys zero differentiation.

## Goals

- **Correctness**: inherit VS Code-grade VT conformance instead of hand-rolling.
- **Features**: gain modes/mouse/colors/wrapping we don't implement, incl. wide-char width.
- **Less maintenance**: delete ~1000 loc of parser; track upstream.
- **Keep one cross-platform core** (mobile RN / Tauri desktop / web) and the existing render layer.

Perf and render reliability are Part 2's goals (Skia).

## Phase 0 — Feasibility (DONE, 2026-07-24)

Proven on the real Android emulator (`tether_test`, x86_64, API 34, RN 0.86, Hermes):

1. `hermesc` compiles the `@xterm/headless@6.0.0` bundle cleanly (EXIT=0, 314KB `.hbc`) — no unsupported language features.
2. On-device import + `write` + buffer read works.

**Required mitigation found:** `@xterm/headless@6.0.0` crashes *at import* under Hermes — its platform detection calls `navigator.userAgent.includes(...)`, and RN's `navigator.userAgent` is `undefined`. Fix is a shim setting `navigator.userAgent`/`navigator.platform` to strings, imported **before** xterm (first import in `index.ts`).

On-device confirmation after the shim (spike output):
```
{"hermes":true,"cols":40,"cursorX":10,"cell0":"H","cell0Bold":true,
 "cell0FgRGB":true,"cell0Fg":"ff0000","wideChar":"你","wideWidth":2,
 "osc133":1,"bell":1,"title":"mytitle","line0":"HELLO 你好"}
```
Confirms: runs on Hermes; wide char width = 2; truecolor + bold SGR; `registerOscHandler(133)` / `onBell` / `onTitleChange` all fire.

## Architecture

### The grid contract (the stable seam)

Today `TerminalEmulator` emits `RenderRow[]`. We keep this contract as the boundary both the new parser and (later) the new renderer speak, but enrich it so a true cell grid is representable (needed for wide chars and exact columns):

```ts
interface Cell { char: string; width: 0 | 1 | 2; fg?: string; bg?: string; attrs: Attrs }
interface GridRow {
  key: number;          // stable logical-line id (buffer.baseY + row)
  cells: Cell[];        // OR keep runs[] — see Decision below
  wrapped: boolean;
  links: LinkSpan[];
  promptStart: boolean;
}
interface Snapshot { rows: GridRow[]; cursor: {row; col; style; visible}; cols; rows }
```

**Decision — keep `RenderRow.runs[]`, add per-cell width where needed.** The current renderer consumes `runs: {text, style}[]`. Rewriting it to consume `cells[]` is Part 2's job. For Part 1 the adapter produces the *existing* `RenderRow` shape (runs) so `TermRow`/`<Text>` is untouched — with one addition: runs carry enough info that wide chars occupy the right column count (emit the correct advance, e.g. a trailing space or width metadata). This keeps Part 1 a pure parser swap. The richer `Cell[]` grid model is introduced in Part 2 when the renderer can use it.

### New module: `terminalEngine.ts` (adapter, ~200 loc)

Wraps a headless `Terminal`, exposes the surface `useTetherApp.tsx` already calls so callers barely change:

| App-facing method (today, on `TerminalEmulator`) | Adapter implementation |
|---|---|
| `write(bytes)` | `term.write(bytes)` |
| `resize(cols, rows)` | `term.resize(cols, rows)` |
| snapshot / `RenderRow[]` getter | read `term.buffer.active`, build rows |
| mouse mode | read `term.modes.mouseTrackingMode` |
| events (data/bell/title/exit) | `term.onData` / `onBell` / `onTitleChange` |

### Feature port map

| Feature today | xterm.js mechanism |
|---|---|
| SGR / 256 / truecolor → theme hex | `cell.isFgDefault/isFgPalette/isFgRGB` + `getFgColor()` → theme map |
| Wide chars (broken) | `cell.getWidth()` → column count |
| OSC 133 prompt marks | `parser.registerOscHandler(133, cb)` + `registerMarker` |
| Links (`links.ts`) | keep span logic, feed it `line.translateToString()` text |
| Mouse mode | `term.modes.mouseTrackingMode` |
| Bell / title / resize | `onBell` / `onTitleChange` / `resize()` |
| Scrollback cap (~1000) | `scrollback` option |
| Stable FlatList row key | `buffer.baseY + row` |

### Change detection (keep current perf)

`term.onWriteParsed` fires after each parsed chunk. Build the snapshot then, diff row-by-row vs the previous snapshot, and **reuse unchanged `RenderRow` objects** so `TermRow`'s `React.memo` still repaints only changed rows — same optimization the current emulator has (it reuses row objects for unchanged lines).

### The navigator shim

New file `apps/mobile/src/xtermPolyfill.ts` (3 lines), imported first in `index.ts`:
```ts
const nav = (globalThis as any).navigator ?? ((globalThis as any).navigator = {});
if (typeof nav.userAgent !== 'string') nav.userAgent = 'ReactNative';
if (typeof nav.platform !== 'string') nav.platform = 'ReactNative';
```

## What changes

- **Add**: `@xterm/headless@6.0.0` dep; `xtermPolyfill.ts`; `terminalEngine.ts` (adapter).
- **Delete**: parser guts of `terminal.ts` + `terminal.parser.test.ts`.
- **Keep**: the `RenderRow`/`CellStyle` types, `links.ts`, `mouseSeq.ts`, theme wiring, `TermRow`/`TerminalScreen` render.
- **Repurpose**: `terminal.test.ts` (760 loc) as adapter conformance tests — feed known byte sequences, assert the emitted `RenderRow[]`. This is the safety net for the swap.
- **Wiring**: `useTetherApp.tsx` swaps `new TerminalEmulator()` for the adapter; API kept compatible so the diff is small.

## Testing

- **Conformance suite** (repurposed `terminal.test.ts`): byte-sequence → expected `RenderRow[]` for: SGR incl 256/truecolor, cursor addressing, erase, scroll regions, alt-screen, wide chars, soft-wrap, OSC 133, OSC 8 links, bell, title. These must pass before and after against the same expectations (where behavior is intended to match).
- **On-device smoke** on the Android sim: launch, run vim / htop / `claude`, confirm alignment + no crash. (Repo already has no runner beyond these unit tests; the sim smoke is manual per project norms.)
- Server-side: unchanged (PTY/WS/DB untouched).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Hermes import crash | Proven + fixed via navigator shim (Phase 0). |
| Snapshot-build perf per chunk vs direct emit | Diff + row-object reuse; measured in Part 2 with Skia. If regressed, throttle snapshot to animation frame. |
| Custom OSC/links/mouse behave differently | Conformance suite covers them; spike already confirmed OSC 133/bell/title fire. |
| Bundle size (+~180KB min) | Acceptable for a native app; headless has no renderer weight. |
| `terminal.ts` also used by desktop/web | Same JS core → same adapter serves all; no per-platform fork. |

## Sequencing

1. Add dep + shim; wire adapter behind the existing `RenderRow` contract; keep `<Text>` render.
2. Port features per the map; make the conformance suite pass.
3. On-device smoke on the sim; delete old parser.
4. Ship. **Then** Part 2 (Skia render) gets its own spec against the enriched `Cell[]` grid.
