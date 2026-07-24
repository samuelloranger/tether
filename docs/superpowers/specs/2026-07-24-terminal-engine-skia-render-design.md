# Terminal Engine Overhaul — Part 2: Skia cell-grid render (native)

**Date:** 2026-07-24
**Status:** Design — pending user review
**Board:** task #368
**Depends on:** Part 1 (parser swap to `@xterm/headless`) — merged/verified. This spec consumes the engine's grid output; it does not touch the parser.

## Problem

Part 1 made the *parser* correct, but the *renderer* is unchanged: each row is React Native `<Text>` runs laid out by text flow, with column position faked from `CHAR_RATIO` (`charWidth = fontSize * ~0.6`). That is not a true cell grid, so it drifts exactly where terminals must not:

- **Column drift** — real glyph advance ≠ `CHAR_RATIO×fontSize`; error accumulates across a line → misaligned TUIs (vim gutters, tables, box-drawing).
- **Wide chars** — the engine now *knows* a CJK/emoji cell is 2 wide (`getWidth()===2`), but RN measures the glyph by its own metrics, so everything after a wide char still shifts. **This is why block 5 of the on-device test can look off even after Part 1.**
- **Background seams, cursor-as-background-hack**, per-platform font fallback.

Real terminals (and xterm.js's own renderers) don't flow text — they **paint a fixed cell grid at integer pixel positions**. Part 2 does that on native via Skia.

## Goals

- **Pixel-accurate cell grid** on iOS/Android: every cell drawn at `col×cellW, row×cellH` with a measured monospace advance. Fixes alignment + wide chars.
- **Perf** on heavy output / fast scroll (GPU-composited).
- **Keep one parser core** and the exact feature set (links, selection, prompt-jump, cursor, themes, mouse).

- **Links must work** (explicit user requirement). Both regex-detected URLs *and* OSC 8 explicit hyperlinks must be tappable in the Skia renderer. OSC 8 was dropped in Part 1 (headless has no per-cell URL getter) — Part 2 restores it: the engine tracks OSC 8 open/close during writes and emits the resulting column ranges into each row's `links` (as an `external` target), so the canvas hit-test treats regex and OSC 8 links identically.

Non-goals: changing the parser core (Part 1); redesigning desktop/web render (see Platform split).

## Decisions

### Scroll model: single canvas + virtual scroll (chosen)

One Skia `<Canvas>` sized to the viewport paints only the visible rows; scrollback is navigated by a scroll offset into the grid (not by mounting 1000 row views). This is the true-terminal approach and the best perf. Cost: scroll gestures, momentum, and selection are hand-built (RN's FlatList no longer provides them). Accepted.

### Platform split: Skia native only; keep `<Text>` on web/desktop

The desktop (Tauri) and web builds render via react-native-web and rely on **native DOM text selection** (`selectable`) and browser monospace metrics, which are already pixel-fine. A Skia/CanvasKit canvas has no native text selection and would *regress* desktop. So:

- **`TerminalView.native.tsx`** → new Skia `TerminalCanvas`.
- **`TerminalView.tsx` (web/desktop)** → the existing `TermRow`/`<Text>` FlatList path, extracted unchanged.

This matches the existing `PresentationView.native/.web` pattern, keeps the shared **engine** (parser + grid contract), and confines the rewrite to where the pain is. The alignment fix is mobile-only by design.

**Desktop is intentionally frozen, not co-maintained.** The web/desktop `<Text>` path is left exactly as-is and receives **zero Part-2 investment** (no Skia, no CanvasKit-on-web, no in-canvas selection). Rationale: the desktop client is slated for a future ground-up native rewrite around libghostty, which will replace this render path wholesale. Spending effort unifying the render now would be thrown away. So "platform split" here means: **build the Skia renderer for native (iOS/Android); leave desktop on the legacy renderer until the libghostty rewrite retires it.** Phase 0 and all Part-2 testing target **iOS + Android only**.

## Phase 0 — Feasibility gate (MUST run before build)

Same discipline as Part 1. `@shopify/react-native-skia` is native (JSI + a large native lib); Expo 57 / RN 0.86 pin a jsi Swift patch (do not bump Expo past 57.0.7). Unknowns to prove **on the Android sim + a real iOS build** before committing:

1. **Builds & links** on this Expo 57 / RN 0.86 project (Android gradle + iOS `expo run:ios`) without disturbing the pinned jsi patch.
2. A trivial `<Canvas>` drawing a rect + a `Text`/`Glyphs` node with a loaded monospace font renders on device.
3. `matchFont`/`useFont` can load a monospace TTF and report a stable per-glyph advance (so `cellW` is exact).
4. **OSC 8 read-back**: confirm the adapter can reconstruct OSC 8 hyperlink column ranges by tracking the OSC 8 open/close handler against the cursor position during writes (headless exposes no per-cell URL, so this is the only path). If it proves unreliable, OSC 8 links degrade to non-tappable (regex links still work) — but this must be decided by evidence, not assumed.

If Skia won't build on the pinned toolchain, fall back: harden the `<Text>` renderer (measure real advance, clamp wide chars) — a smaller reliability gain, no native dep.

## Architecture

### Enriched grid contract (engine addition, non-breaking)

Add a cell-level accessor to `TerminalEngine` alongside `getSnapshot()` (which web/desktop keeps using):

```ts
interface GridCell { char: string; width: 0 | 1 | 2; fg: string; bg: string; attrs: number }
interface GridSnapshot {
  rows: { key: number; cells: GridCell[]; wrapped: boolean; promptStart: boolean; links: LinkSpan[] }[];
  cursor: { row: number; col: number; style: 'block' | 'bar' | 'underline'; visible: boolean };
  cols: number;
  rowCount: number;   // viewport row count (grid height)
  baseY: number;      // scrollback size, for scroll math
}
getGrid(): GridSnapshot   // reuses row objects like getSnapshot for cheap diffing
```

`fg`/`bg` are resolved hex (palette/theme applied in the engine, as today). `attrs` is a bitmask (bold/dim/italic/underline/strike/inverse) so the painter branches cheaply.

### `TerminalCanvas` (native renderer)

- **Font**: `useFont(require('fira-code.ttf'), fontSize)` from the `@expo-google-fonts/fira-code` package's TTF. Measure advance once via `font.getGlyphWidths`/`measureText('M')` → `cellW`. `cellH = round(fontSize * lineHeight)` (reuse current 1.3).
- **Paint loop**: for each visible row `r` and cell `c`: fill `bg` rect at `(c*cellW, r*cellH, width*cellW, cellH)` only when non-default; draw glyph at baseline; wide cells (`width===2`) span `2*cellW`; skip `width===0` spacer cells. Underline/strike as lines; inverse swaps fg/bg; dim lowers alpha.
- **Cursor**: overlay rect/bar/underline at `(col*cellW, row*cellH)` in accent; block caret inverts the glyph. Blink via a shared value, gated by `reduceMotion`.
- **Virtual scroll**: a vertical `Gesture.Pan` (react-native-gesture-handler, already present) drives a `scrollTop` shared value into `[0, (totalRows-viewRows)*cellH]`; only rows in `[scrollTop/cellH, +viewRows]` are painted. Momentum via `withDecay`. `autoScroll` (stick-to-bottom) preserved: when at bottom, new output keeps `scrollTop` pinned.
- **Tap → cell**: `col = floor(x/cellW)`, `row = floor((y+scrollTop)/cellH)`. Reuse the existing mouse-report path (`mouseSeq`) and keyboard-focus tap logic — just a new coordinate source.
- **Links**: hit-test the tapped cell against the row's `links` spans (already column ranges) → open target. Same `links.ts` data.
- **Selection**: mobile already delegates selection to the fullscreen `SelectionView` (long-press → selectable text from `getFullText`). Keep that unchanged — no in-canvas selection needed. (Double-tap-to-copy-word maps a tapped cell to `wordAt`.)

### What changes

- **Add**: `@shopify/react-native-skia`; `TerminalView.native.tsx` (Skia); `TerminalView.tsx` (extract current `<Text>` path); `getGrid()` on `TerminalEngine`; a bundled Fira Code TTF asset.
- **Modify**: `TerminalScreen.tsx` renders `<TerminalView>` (platform-resolved) instead of the inline FlatList block; `useTetherApp.tsx` scroll/tap helpers adapted for the canvas coordinate source on native.
- **Keep**: parser/engine, `links.ts`, `mouseSeq.ts`, `SelectionView`, `wordAt`, themes; the entire web/desktop render path (moved into `TerminalView.tsx`, otherwise untouched).

## Testing

- **Unit**: `getGrid()` cell/width/color/cursor correctness (byte seq → grid), mirroring Part 1's suite. Cell-metric math (`cellW`/`cellH`, tap→cell inverse) as pure functions.
- **On-device (Android sim + iOS build)**: run `tether-engine-test.sh`. Block 4 (box-drawing) and block 5 (wide chars/emoji) — the Part-1-suspect blocks — **must now align pixel-perfect**. vim/htop/less alignment, fast-scroll smoothness, tap-to-focus, link tap, prompt-jump, reconnect stick-to-bottom.
- **Desktop regression**: confirm web/desktop still uses `<Text>` path and native selection still works (unchanged code, but verify the platform split resolves correctly).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| react-native-skia won't build on pinned Expo 57 / jsi patch | Phase-0 gate before any build; fallback = harden `<Text>` renderer |
| Hand-built scroll feels worse than FlatList | Reuse gesture-handler + `withDecay`; tune; keep stick-to-bottom semantics |
| Font advance not truly monospace for all glyphs (emoji/CJK) | Measure ASCII advance for `cellW`; force wide cells to `2*cellW` regardless of glyph metrics (grid is authoritative, not the font) |
| Per-frame grid build + paint cost | `getGrid()` reuses row objects; only paint visible rows; repaint only on `onWriteParsed` / scroll |
| Desktop accidentally gets Skia | Explicit `.native`/`.web` file split; verify bundler resolution in tests |

## Sequencing

1. **Phase 0**: skia build/render spike on Android sim + iOS. Gate.
2. Add `getGrid()` to the engine + unit tests.
3. Extract current render into `TerminalView.tsx` (web/desktop) — no behavior change; verify desktop unaffected.
4. Build `TerminalView.native.tsx` (Skia): static paint of one grid snapshot first (no scroll), verify alignment on device.
5. Add virtual scroll + stick-to-bottom; tap→cell, links, cursor, blink.
6. Wire into `TerminalScreen`; on-device full smoke; measure perf.
7. Ship. Then close the **OSC 8 hyperlink** follow-up from Part 1.
