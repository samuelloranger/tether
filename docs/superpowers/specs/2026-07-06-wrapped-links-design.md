# Wrapped links survive line-break — design

**Date:** 2026-07-06
**Component:** `apps/mobile` (terminal emulator + render)
**Board:** task #44

## Problem

The mobile terminal is a grid emulator: each screen row is rendered as a
separate `TermRow` (`App.tsx`, `numberOfLines={1}`, fixed height). Link
detection (`App.tsx:66` `URL_RE`, `:89` split) runs **per visual row**.

When a URL is longer than the terminal width, the PTY autowraps it across two
grid rows:

- Row A: `https://example.com/really/long/pa`
- Row B: `th?x=1`

Row A's `onPress` opens a **truncated** URL; Row B doesn't start with `http`
so it isn't tappable at all. The link dies at the line break.

## Root cause

The emulator autowraps in `putChar` (`terminal.ts:535-537`):

```ts
if (this.cx + w > this.cols) {
  this.cx = 0;
  this.lineFeed();
}
```

It stores **no soft-wrap marker**. So the grid cannot distinguish a row that
wrapped because it hit the right edge (same *logical* line) from a row that
ended with an explicit `\n` (a different logical line). That distinction is
exactly what's needed to rejoin a wrapped URL without merging unrelated lines.

## Approach

Track the soft-wrap boundary in the emulator, expose it on the render
snapshot, and reconstruct full URLs across wrapped rows at render time.
Tapping **any** fragment of a wrapped URL opens the complete link.

Rejected alternative — a render-layer heuristic (join when a URL runs to the
last column and the next row starts non-space): fragile. It can't tell soft
from hard wrap, false-merges unrelated lines, and the column math fights the
trailing-blank trimming in `mergeRuns`.

## Components

### 1. Emulator soft-wrap tracking (`terminal.ts`)

Lines are plain `Cell[][]` (`screen`, `scrollback`) with no per-line object,
so the flag lives in parallel `boolean[]` arrays kept in lockstep:

- `screenWrap: boolean[]` (length = rows), `scrollbackWrap: boolean[]`.
- **Set** the *leaving* row's flag `true` at the autowrap point in `putChar`,
  before `lineFeed()`. Every other path to `lineFeed` (C0 `\n`, IND, NEL)
  leaves the flag `false` — this is the soft-vs-hard distinction.
- **`scrollUp`:** when a line moves screen→scrollback, move its wrap flag with
  it; the new blank screen line gets `false`.
- **Clears / `blankLine` / cursor-addressed overwrites:** reset the affected
  row's flag to `false` (a cleared or repainted line is no longer a wrap
  continuation).
- **`reset` / `resize`:** reset all flags to `false`. After a resize the flags
  may be stale; resetting is safe — a wrapped link simply won't join until the
  content is reprinted. (No reflow of existing content happens here.)

### 2. Snapshot exposure (`getSnapshot` / `RenderRow`)

- Add `wrapped: boolean` to `RenderRow`, meaning "this row's logical line
  continues on the next row."
- `getSnapshot` builds each row's `wrapped` from the combined
  `[...scrollbackWrap, ...screenWrap]` flags, aligned with the existing
  `[...scrollback, ...screen]` line concatenation.
- Fold `wrapped` into `runsEqual` so a row whose wrap state changed produces a
  fresh object — preserving the referential-stability memo used by `TermRow`.

### 3. URL reconstruction at render (`App.tsx`)

- Before rendering the visible rows, group **consecutive** `wrapped` rows into
  logical lines. Concatenate their text, run `URL_RE` on the **joined** string.
- Map each match back to per-row fragments, each carrying the **full**
  reconstructed URL. Handles N-row wraps and the scrollback/screen boundary
  generically (grouping runs over the combined row list).
- `TermRow` renders these precomputed segments instead of splitting per-row
  text on `URL_RE`. A link fragment's `onPress` calls
  `Linking.openURL(fullUrl)` — so tapping row A *or* row B opens the whole
  link. Fold the resolved segments into the `TermRow` memo comparator so
  changed link state re-renders correctly.

## Data flow

```
emulator (screenWrap/scrollbackWrap)
  → getSnapshot (RenderRow.wrapped)
    → App: group wrapped rows → join text → URL_RE → per-row full-URL segments
      → TermRow: render segments; onPress = Linking.openURL(fullUrl)
```

## Error handling

A partial/garbage token at a wrap edge just yields whatever the joined text
matches; `Linking.openURL` on a non-URL is a no-op / rejected promise, no
crash path. No new failure modes.

## Testing (`terminal.test.ts`)

- URL wrapped across 2 rows → row A marked `wrapped`; both fragments resolve to
  the full URL.
- Two separate lines each with a URL, separated by a hard `\n` → **not**
  joined; each stays its own link.
- URL wrapping across 3 rows → all fragments resolve to the full URL.
- URL wrapping across the scrollback/screen boundary → resolves.
- (Snapshot-level) `wrapped` flag correctly set on autowrap and cleared on
  explicit newline / scroll / clear.

## Out of scope (YAGNI)

- OSC 8 explicit hyperlinks (separate feature).
- Link continuity across a resize reflow (flags reset on resize).
- A single tap-target that visually spans rows (RN `<Text>` can't span
  sibling row `View`s; both fragments opening the full URL is the accepted
  interaction).
