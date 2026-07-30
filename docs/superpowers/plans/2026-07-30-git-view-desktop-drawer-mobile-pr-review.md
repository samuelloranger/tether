# Git View Redesign (Desktop Drawer + Mobile PR Review) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared full-screen `DiffView` with a desktop `GitDrawer` (~¾ width, terminal strip stays live) and a mobile `GitReview` (GitHub PR Files–style continuous scroll), reusing existing git APIs and diff primitives.

**Architecture:** Extract small shared UI/pure helpers (`CommitBox`, `DiffFileBody`, `GitTabBar`, `HistoryList`, review-order + collapse + concurrency helpers). Desktop overlays `GitDrawer` on the still-mounted terminal. Mobile swaps to full-screen `GitReview` with progressive parallel per-file GETs. `useTetherApp` keeps stage/commit/history; desktop still uses single-file `selectDiffFile`, mobile adds a review-diff cache keyed by `mode:path`.

**Tech Stack:** React 19, React Native 0.86 / react-native-web, Expo 57, TypeScript, Bun tests (`bun:test`), Jest + RNTL (`test:ui`), existing `diffModel` / git HTTP routes.

## Global Constraints

- No server API changes for v1 (parallel existing per-file GETs only).
- Desktop drawer ≈ **75%** window width; remaining strip is live terminal (must stay mounted while open).
- Mobile continuous feed is **unified only**; side-by-side stays desktop/wide.
- Working-tree section order is always **Staged**, then **Changes**.
- Desktop: CommitBox sticky at **bottom of left column**. Mobile: CommitBox sticky at **top**.
- History retained on both; no hunk actions on commit diffs.
- Entry points unchanged (Change banner / menu → `openDiff`).
- Do not collapse the desktop **right-pane** diff; folder collapse remains left-list only.
- Reuse `FileTree`, `DiffLines`, `SideBySideDiff`, `ImageDiff`, `groupSummary`, `buildFileTree`, `displayDiff`, `isImagePath`.
- Biome formatting; run focused mobile tests + `bun --cwd apps/mobile run typecheck` before claiming a task done.
- Spec: `docs/superpowers/specs/2026-07-30-git-view-desktop-drawer-mobile-pr-review-design.md`.

## File map

| File | Responsibility |
|---|---|
| `apps/mobile/src/gitReviewModel.ts` | Pure: review file order, collapse toggle, concurrency mapper, review cache key |
| `apps/mobile/src/CommitBox.tsx` | Shared commit message + Commit button |
| `apps/mobile/src/DiffFileBody.tsx` | Loading / error / image / unified / SBS body for one file |
| `apps/mobile/src/GitTabBar.tsx` | Working tree \| History tabs |
| `apps/mobile/src/HistoryList.tsx` | Commit list rows |
| `apps/mobile/src/GitDrawer.tsx` | Desktop shell |
| `apps/mobile/src/GitReview.tsx` | Mobile shell |
| `apps/mobile/src/TerminalScreen.tsx` | Mount terminal under drawer; route shells |
| `apps/mobile/src/useTetherApp.tsx` | Review-diff cache + refresh hooks; keep existing git ops |
| `apps/mobile/src/DiffView.tsx` | Delete after shells land (or leave a thin deprecated re-export for one commit, then delete) |
| `apps/mobile/src/chromeAlignment.test.ts` | Point TEXT_METRICS checks at the new shells |
| Tests colocated / `__tests__/` | Per task below |

---

### Task 1: Pure review helpers

**Files:**
- Create: `apps/mobile/src/gitReviewModel.ts`
- Create: `apps/mobile/src/gitReviewModel.test.ts`

**Interfaces:**
- Consumes: `DiffSummary`, `DiffFileStat`, `groupSummary` from `./diffModel`.
- Produces:
  - `ReviewFileEntry = { path: string; mode: 'staged' \| 'unstaged'; file: DiffFileStat }`
  - `reviewFileEntries(summary: DiffSummary): ReviewFileEntry[]`
  - `reviewDiffKey(mode: 'staged' \| 'unstaged', path: string): string` → `` `${mode}:${path}` ``
  - `toggleSetMember(set: Set<string>, key: string): Set<string>`
  - `canCommit(stagedCount: number, message: string, committing: boolean): boolean`
  - `mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]>`

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test';
import type { DiffSummary } from './diffModel';
import {
  canCommit,
  mapWithConcurrency,
  reviewDiffKey,
  reviewFileEntries,
  toggleSetMember,
} from './gitReviewModel';

test('reviewFileEntries lists staged then unstaged preserving summary order within each group', () => {
  const summary: DiffSummary = {
    files: [
      { path: 'b.ts', insertions: 1, deletions: 0, binary: false, staged: false },
      { path: 'a.ts', insertions: 1, deletions: 0, binary: false, staged: true },
      { path: 'c.ts', insertions: 0, deletions: 1, binary: false, staged: true },
    ],
  };
  expect(reviewFileEntries(summary).map((e) => `${e.mode}:${e.path}`)).toEqual([
    'staged:a.ts',
    'staged:c.ts',
    'unstaged:b.ts',
  ]);
});

test('reviewDiffKey distinguishes the same path on both sides of the index', () => {
  expect(reviewDiffKey('staged', 'x.ts')).toBe('staged:x.ts');
  expect(reviewDiffKey('unstaged', 'x.ts')).toBe('unstaged:x.ts');
});

test('toggleSetMember adds then removes', () => {
  const once = toggleSetMember(new Set(), 'a');
  expect(once.has('a')).toBe(true);
  expect(toggleSetMember(once, 'a').has('a')).toBe(false);
});

test('canCommit requires staged files, non-empty message, and idle commit', () => {
  expect(canCommit(1, 'msg', false)).toBe(true);
  expect(canCommit(0, 'msg', false)).toBe(false);
  expect(canCommit(1, '  ', false)).toBe(false);
  expect(canCommit(1, 'msg', true)).toBe(false);
});

test('mapWithConcurrency respects the limit and preserves order', async () => {
  let inflight = 0;
  let max = 0;
  const items = [1, 2, 3, 4, 5];
  const out = await mapWithConcurrency(items, 2, async (n) => {
    inflight++;
    max = Math.max(max, inflight);
    await Bun.sleep(5);
    inflight--;
    return n * 10;
  });
  expect(out).toEqual([10, 20, 30, 40, 50]);
  expect(max).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun --cwd apps/mobile test src/gitReviewModel.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `gitReviewModel.ts`**

```ts
import { type DiffFileStat, type DiffSummary, groupSummary } from './diffModel';

export type ReviewFileEntry = {
  path: string;
  mode: 'staged' | 'unstaged';
  file: DiffFileStat;
};

export function reviewFileEntries(summary: DiffSummary): ReviewFileEntry[] {
  const { staged, unstaged } = groupSummary(summary);
  return [
    ...staged.map((file) => ({ path: file.path, mode: 'staged' as const, file })),
    ...unstaged.map((file) => ({ path: file.path, mode: 'unstaged' as const, file })),
  ];
}

export function reviewDiffKey(mode: 'staged' | 'unstaged', path: string): string {
  return `${mode}:${path}`;
}

export function toggleSetMember(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function canCommit(stagedCount: number, message: string, committing: boolean): boolean {
  return stagedCount > 0 && message.trim().length > 0 && !committing;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun --cwd apps/mobile test src/gitReviewModel.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/gitReviewModel.ts apps/mobile/src/gitReviewModel.test.ts
git commit -m "feat(mobile): add git review pure helpers"
```

---

### Task 2: Extract `CommitBox`

**Files:**
- Create: `apps/mobile/src/CommitBox.tsx`
- Create: `apps/mobile/__tests__/CommitBox.spec.tsx`

**Interfaces:**
- Consumes: `canCommit` from `./gitReviewModel`; theme via `useAppTheme`.
- Produces: `CommitBox({ message, onChangeMessage, onCommit, stagedCount, committing, style? })`.

- [ ] **Step 1: Write the failing component test**

Use the project’s existing RNTL setup (mirror `SessionDrawer.spec.tsx` theme/provider mocks). Assert:

```tsx
expect(view.getByPlaceholderText('Commit message')).toBeTruthy();
expect(view.getByLabelText('Commit staged changes')).toBeDisabled(); // empty message
fireEvent.changeText(view.getByPlaceholderText('Commit message'), 'fix bugs');
expect(view.getByLabelText('Commit staged changes')).not.toBeDisabled();
fireEvent.press(view.getByLabelText('Commit staged changes'));
expect(onCommit).toHaveBeenCalled();
```

With `stagedCount={0}`, Commit stays disabled even with a message.

- [ ] **Step 2: Run — expect FAIL**

```bash
bun --cwd apps/mobile run test:ui --runInBand __tests__/CommitBox.spec.tsx
```

- [ ] **Step 3: Implement `CommitBox`**

Lift the commit bar JSX from `DiffView.tsx` (input + button + ActivityIndicator). Use `canCommit(stagedCount, message, committing)` for disabled/opacity. Keep accessibility label `Commit staged changes`.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/CommitBox.tsx apps/mobile/__tests__/CommitBox.spec.tsx
git commit -m "feat(mobile): extract CommitBox for git shells"
```

---

### Task 3: Extract `DiffFileBody` + `GitTabBar` + `HistoryList`

**Files:**
- Create: `apps/mobile/src/DiffFileBody.tsx`
- Create: `apps/mobile/src/GitTabBar.tsx`
- Create: `apps/mobile/src/HistoryList.tsx`
- Create: `apps/mobile/__tests__/DiffFileBody.spec.tsx` (minimal)

**Interfaces:**
- Consumes: `DiffLines`, `SideBySideDiff`, `ImageDiff`, `displayDiff`; `GitLogEntry` type already used by `DiffView`.
- Produces:
  - `DiffFileBody({ loading, error?, path, diffText, truncated, image?, sideBySide, wideEnough, hunks?, onHunkPress?, hunkActionLabel? })`
  - `GitTabBar({ tab: 'changes' \| 'history', onChanges, onHistory })`
  - `HistoryList({ entries: GitLogEntry[] \| null, onSelect })`

- [ ] **Step 1: Failing test for DiffFileBody empty/loading/error**

```tsx
expect(render(<DiffFileBody loading path="a.ts" ... />).getByRole('progressbar') /* or ActivityIndicator via testID */).toBeTruthy();
// error path:
expect(render(<DiffFileBody loading={false} error="boom" path="a.ts" onRetry={onRetry} ... />).getByText('boom')).toBeTruthy();
fireEvent.press(view.getByLabelText('Retry loading diff'));
expect(onRetry).toHaveBeenCalled();
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement the three components**

`DiffFileBody` rules:

- `loading` → centered `ActivityIndicator`
- `error` → message + Retry button (`accessibilityLabel="Retry loading diff"`)
- image when `image` prop set → `ImageDiff`
- else if `sideBySide && wideEnough` → `SideBySideDiff` with `displayDiff`
- else → `DiffLines` with optional hunk press

`GitTabBar`: copy tab labels from current DiffView (`Working tree` / `History`).

`HistoryList`: null → spinner; `[]` → “No commits”; else rows matching current DiffView commit row UI.

- [ ] **Step 4: Run focused UI test — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/DiffFileBody.tsx apps/mobile/src/GitTabBar.tsx apps/mobile/src/HistoryList.tsx apps/mobile/__tests__/DiffFileBody.spec.tsx
git commit -m "feat(mobile): extract DiffFileBody, GitTabBar, HistoryList"
```

---

### Task 4: Desktop `GitDrawer`

**Files:**
- Create: `apps/mobile/src/GitDrawer.tsx`
- Create: `apps/mobile/__tests__/GitDrawer.spec.tsx`
- Modify: `apps/mobile/src/chromeAlignment.test.ts` (add `GitDrawer` TEXT_METRICS expectations alongside or instead of DiffView once DiffView is gone — for this task, **add** GitDrawer checks)

**Interfaces:**
- Consumes: same prop surface as current `DiffView` (summary, selectedPath, diffMode, diffText, … stage/commit/history callbacks) plus `onClose` (alias of today’s `onBack` when no drill-in).
- Produces: right-anchored panel at `Math.round(windowWidth * 0.75)` with left column (~⅓) and right column (~⅔).

Layout:

```
┌─────────────────────────────────────────────┐
│ terminal (~25%) │ GitDrawer (~75%)          │
│                 │ [header Close] [tabs]     │
│                 │ left list │ right DiffFile│
│                 │ CommitBox │ Body          │
└─────────────────────────────────────────────┘
```

- [ ] **Step 1: Failing layout test**

Render `GitDrawer` with a non-empty summary and assert:

```tsx
expect(view.getByLabelText('Close git drawer')).toBeTruthy();
expect(view.getByText('Staged (1)')).toBeTruthy(); // or section header text matching DiffView
expect(view.getByText('Changes (1)')).toBeTruthy();
expect(view.getByPlaceholderText('Commit message')).toBeTruthy();
expect(view.getByText('Select a file')).toBeTruthy(); // empty right pane
```

Press a file row → `onSelectFile` called with `(path, 'unstaged'|'staged')`.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `GitDrawer`**

- Root: `position: 'absolute'`, `top/right/bottom: 0`, `width: Math.round(width * 0.75)`, `zIndex` above terminal (e.g. 50), themed background + left border.
- Header: Close control (`accessibilityLabel="Close git drawer"`) calling `onBack` / `onClose`. Include path / SBS toggle when a file is selected (same as DiffView). Use `TEXT_METRICS` for header text like DiffView.
- `GitTabBar` under header.
- Working tree: row with left `ScrollView` (`FileTree` sections Staged → Changes + actions) and sticky `CommitBox` at bottom of left column; right = `DiffFileBody` or “Select a file”.
- History: left `HistoryList`; right = commit `DiffFileBody` without hunks (or spinner). Selecting a commit uses existing `onSelectCommit`.
- Desktop Esc: `useEffect` on `keydown` when drawer mounted — if target is commit `TextInput`, first Esc blurs; else call `onBack`. Do **not** steal Esc from the terminal strip (only listen when `event.target` is inside the drawer DOM node — attach ref + `contains`).

Do not auto-select a file on open (empty right pane is intentional).

- [ ] **Step 4: Run — PASS**; update chromeAlignment to include GitDrawer header metrics.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/GitDrawer.tsx apps/mobile/__tests__/GitDrawer.spec.tsx apps/mobile/src/chromeAlignment.test.ts
git commit -m "feat(mobile): add desktop GitDrawer shell"
```

---

### Task 5: Review-diff cache in `useTetherApp`

**Files:**
- Modify: `apps/mobile/src/useTetherApp.tsx`
- Create: `apps/mobile/src/gitReviewModel.test.ts` already has concurrency — add unit test file for cache merge if extracted, otherwise keep logic in hook and cover via GitReview later
- Prefer extracting fetch helper: Create `apps/mobile/src/fetchReviewDiff.ts` + test

**Interfaces:**
- Produces (from hook return / facade):
  - `reviewDiffs: Record<string, ReviewDiffSlot>`
  - `loadReviewDiffs(): void` — called from `openDiff` on mobile / whenever GitReview mounts
  - `retryReviewDiff(mode, path): void`
  - `refreshReviewDiff(mode, path): void` — after stage/unstage/hunk for that key
  - `clearReviewDiffs()` — on `closeDiff`

```ts
export type ReviewDiffSlot =
  | { status: 'loading' }
  | { status: 'ready'; text: string; truncated: boolean }
  | { status: 'image'; old: string | null; new: string | null }
  | { status: 'error'; message: string };
```

- [ ] **Step 1: Extract + test `fetchOneReviewDiff`**

Create `apps/mobile/src/fetchReviewDiff.ts` that takes `{ client, sessionId, path, mode, file }` and returns a `ReviewDiffSlot` (ready/image/error) — mirror `selectDiffFile` URL building (`mode` query, image sides). Unit-test URL/mode with a fake client that records paths (no network).

- [ ] **Step 2: Run — FAIL then implement — PASS**

- [ ] **Step 3: Wire cache into `useTetherApp`**

```ts
const [reviewDiffs, setReviewDiffs] = useState<Record<string, ReviewDiffSlot>>({});

const loadReviewDiffs = useCallback(() => {
  const entries = reviewFileEntries(entryFor(getActiveSessionId()).diffSummary);
  setReviewDiffs((prev) => {
    const next = { ...prev };
    for (const e of entries) {
      const key = reviewDiffKey(e.mode, e.path);
      if (!next[key] || next[key].status === 'error') next[key] = { status: 'loading' };
    }
    return next;
  });
  void mapWithConcurrency(entries, 5, async (e) => {
    const key = reviewDiffKey(e.mode, e.path);
    const slot = await fetchOneReviewDiff({ ... });
    setReviewDiffs((prev) => ({ ...prev, [key]: slot }));
    return slot;
  });
}, [...]);
```

- On `openDiff`: keep desktop behavior; call `loadReviewDiffs()` always (cheap no-op cost) or only when `!isDesktop` — prefer always so switching shells is simple.
- On `closeDiff`: `setReviewDiffs({})`.
- Update `stageFile` / `unstageFile` / `toggleHunk` / `refreshOpenDiff`: after success, also `refreshReviewDiff` for the affected `mode:path` (hunk ops use current mode; file stage moves sides — simplest: `loadReviewDiffs()` full refresh after any write that changes summary — OK for v1).
- Prefer **full `loadReviewDiffs()` after every successful git write** while `diffOpen` to avoid stale staged/unstaged split. Still call `refreshOpenDiff()` for desktop selected file.

Export `reviewDiffs`, `loadReviewDiffs`, `retryReviewDiff` through the facade like other diff fields.

- [ ] **Step 4: `bun --cwd apps/mobile test src/fetchReviewDiff.test.ts` + typecheck**

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/fetchReviewDiff.ts apps/mobile/src/fetchReviewDiff.test.ts apps/mobile/src/useTetherApp.tsx
git commit -m "feat(mobile): progressive per-file review diff cache"
```

---

### Task 6: Mobile `GitReview`

**Files:**
- Create: `apps/mobile/src/GitReview.tsx`
- Create: `apps/mobile/__tests__/GitReview.spec.tsx`
- Modify: `apps/mobile/src/chromeAlignment.test.ts` (GitReview header metrics)

**Interfaces:**
- Consumes: DiffView-equivalent props **plus** `reviewDiffs`, `onRetryReviewDiff(mode, path)`, and uses `reviewFileEntries` / `toggleSetMember` / `reviewDiffKey` locally for collapse.
- Produces: full-screen Working tree continuous scroll + History.

- [ ] **Step 1: Failing UI test**

With staged + unstaged fixtures and `reviewDiffs` ready slots:

```tsx
expect(view.getByLabelText('Back to terminal')).toBeTruthy();
expect(view.getByPlaceholderText('Commit message')).toBeTruthy(); // top
expect(view.getByText('Staged (1)')).toBeTruthy();
expect(view.getByText('Changes (1)')).toBeTruthy();
fireEvent.press(view.getByLabelText('Collapse file a.ts')); // or Expand
// hunk Stage label present when expanded
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `GitReview`**

Structure:

1. Header Back → `onBack` (always exits to terminal; history commit drill uses secondary back like DiffView or in-list).
2. `GitTabBar`.
3. Working tree:
   - Sticky `CommitBox` at top (`stagedCount={groups.staged.length}`).
   - `ScrollView` of sections: for each `reviewFileEntries` entry, render a file header (path, +/- or binary, file-level stage/unstage/discard buttons, chevron). Collapse key = `reviewDiffKey(mode, path)`. Default expanded (`collapsed` set empty). Body when expanded: `DiffFileBody` from `reviewDiffs[key]` with hunks enabled; `onRetry` → `onRetryReviewDiff`.
4. History: `HistoryList` → on select show commit diff via existing `historyCommit` / `DiffFileBody` without hunks (same as DiffView drill-in).

Call `loadReviewDiffs` from parent when opening — not inside GitReview on every render. Optional `useEffect` once on mount if parent forgets is OK as belt-and-suspenders.

- [ ] **Step 4: PASS + chromeAlignment includes GitReview**

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/GitReview.tsx apps/mobile/__tests__/GitReview.spec.tsx apps/mobile/src/chromeAlignment.test.ts
git commit -m "feat(mobile): add mobile GitReview continuous scroll"
```

---

### Task 7: Wire `TerminalScreen` — desktop overlay, mobile takeover

**Files:**
- Modify: `apps/mobile/src/TerminalScreen.tsx`
- Modify: `apps/mobile/src/useTetherApp.tsx` (export new fields if not already)
- Create: `apps/mobile/__tests__/GitShellRouting.spec.tsx` (or extend an existing TerminalScreen desktop test)

**Interfaces:**
- Consumes: `desktopUi`, `diffOpen`, existing diff props, `reviewDiffs`, `retryReviewDiff`, `loadReviewDiffs`.

Critical layout change: when `diffOpen && desktopUi`, **do not** replace the terminal branch with DiffView. Keep rendering the terminal area + ChangeBanner path suppressed, and overlay `GitDrawer`. When `diffOpen && !desktopUi`, render `GitReview` full-screen (current DiffView slot).

Sketch:

```tsx
{fileView ? (
  <FileViewer ... />
) : diffOpen && !desktopUi ? (
  <GitReview ... reviewDiffs={reviewDiffs} onRetryReviewDiff={retryReviewDiff} ... />
) : activePresentation ? (
  ...
) : (
  <>
    {!desktopUi && <ChangeBanner ... />}
    <View style={styles.terminalArea}>...</View>
    ...
  </>
)}
{diffOpen && desktopUi ? (
  <GitDrawer ... />
) : null}
```

Ensure desktop Change banner / menu still call `openDiff`. While desktop drawer open, terminal remains focusable in the left strip.

On `openDiff`, call `loadReviewDiffs()`.

- [ ] **Step 1: Failing routing test**

Mock `desktopUi` true + `diffOpen` true → assert terminal-related a11y (e.g. terminal area / session chrome) still present **and** `Close git drawer` present. Mobile mock → `Back to terminal` from GitReview, no `Close git drawer`.

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement wiring as above; remove `DiffView` import**

- [ ] **Step 4: PASS + typecheck

```bash
bun --cwd apps/mobile run test:ui --runInBand __tests__/GitShellRouting.spec.tsx __tests__/GitDrawer.spec.tsx __tests__/GitReview.spec.tsx
bun --cwd apps/mobile run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/TerminalScreen.tsx apps/mobile/src/useTetherApp.tsx apps/mobile/__tests__/GitShellRouting.spec.tsx
git commit -m "feat(mobile): route GitDrawer and GitReview from TerminalScreen"
```

---

### Task 8: Retire `DiffView` + final alignment

**Files:**
- Delete: `apps/mobile/src/DiffView.tsx`
- Modify: `apps/mobile/src/chromeAlignment.test.ts` — drop DiffView; keep GitDrawer + GitReview (+ FileViewer)
- Grep for any remaining `DiffView` imports and fix

- [ ] **Step 1: Grep and failing chromeAlignment if still pointing at DiffView**

```bash
rg "DiffView" apps/mobile
```

- [ ] **Step 2: Delete DiffView; fix chromeAlignment**

- [ ] **Step 3: Full focused verification**

```bash
bun --cwd apps/mobile test src/gitReviewModel.test.ts src/fetchReviewDiff.test.ts src/diffModel.test.ts src/chromeAlignment.test.ts
bun --cwd apps/mobile run test:ui --runInBand __tests__/CommitBox.spec.tsx __tests__/DiffFileBody.spec.tsx __tests__/GitDrawer.spec.tsx __tests__/GitReview.spec.tsx __tests__/GitShellRouting.spec.tsx
bun --cwd apps/mobile run typecheck
```

Expected: all pass.

- [ ] **Step 4: Manual smoke (desktop Tauri + Expo)**

- Desktop: open changes → ~¾ drawer, type in left terminal strip, select file, stage hunk, commit from left column, History tab, Esc closes.
- Mobile: continuous Staged→Changes, collapse file, stage hunk, commit from top, History.

- [ ] **Step 5: Commit**

```bash
git add -u apps/mobile/src/DiffView.tsx apps/mobile/src/chromeAlignment.test.ts
git commit -m "refactor(mobile): retire DiffView after git shell split"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Desktop ~¾ drawer, live terminal | 4, 7 |
| Left Staged/Changes + sticky commit bottom | 2, 4 |
| Right selected-file diff + hunks + SBS | 3, 4 |
| Desktop History left/right | 3, 4 |
| Mobile full-screen continuous scroll | 6, 7 |
| Mobile Staged then Changes | 1, 6 |
| Per-file collapse; unified only | 1, 6 |
| Sticky commit top (mobile) | 2, 6 |
| Progressive parallel GETs | 1, 5, 6 |
| No server API change | Global |
| Entry points unchanged | 7 |
| Retire DiffView as sole shell | 8 |

## Placeholder / consistency notes

- Review cache key is always `reviewDiffKey(mode, path)` — never path alone.
- `canCommit` is the single enable rule for CommitBox on both platforms.
- After git writes while open: `loadReviewDiffs()` + desktop `refreshOpenDiff()`.
