# Git view redesign — desktop drawer + mobile PR review

**Date:** 2026-07-30  
**Status:** Approved for planning  
**Supersedes (layout only):** the single full-screen `DiffView` shell used for both platforms. Git APIs, `diffModel`, hunk staging, and history endpoints from prior specs remain.

## Problem

Today’s git UI is one shared `DiffView`: Changes/History tabs, staged + unstaged file trees, drill-in to a single file, commit bar at the bottom. That works, but:

- **Desktop** wants a VS Code–like SCM experience while keeping the terminal visible.
- **Mobile** wants a GitHub PR Files–like continuous review, not a file-list → one-file drill-in.

## Goals

### Desktop — `GitDrawer`

- Drawer covering the full terminal column; session sidebar stays visible. Terminal remains mounted underneath while the drawer is open.
- **Left:** file list (Staged, then Changes) + sticky commit box in that column; folder collapse as today.
- **Right:** selected file’s modifications (unified / side-by-side when wide enough, hunk stage/unstage, image diffs).
- **History** retained: left commit list, right commit diff (no hunk actions).
- Entry: title-bar **Changes** button (beside Settings), not a banner.

### Mobile — `GitReview`

- Full-screen takeover (same entry points: Change banner / menu).
- Continuous scroll like GitHub PR **Files**: section **Staged**, then **Changes**, each file’s diff in order.
- Per-hunk stage/unstage; per-file **collapse/expand** from the file header (GitHub-style).
- Sticky **commit box at the top** of the working-tree view.
- **History** retained (list → commit diff).

### Shared

- Reuse `diffModel`, `FileTree`, `DiffLines`, `SideBySideDiff`, `ImageDiff`, and existing `/api/sessions/:id/git/*` / diff hooks.
- No server protocol change required for v1 (parallel per-file fetches on mobile).

## Non-goals

- Inline review comments / approvals.
- Changing how the Change banner opens the view.
- Collapsing the desktop **right-pane** diff (desktop folder collapse on the left only).
- A new headless “review engine” abstraction (YAGNI until a third surface appears).
- Batch diff API unless parallel GETs prove insufficient.

## Approach

**Platform shells + shared primitives** (chosen over one flagged `DiffView` or a premature shared controller):

| Shell | Platform | Role |
|---|---|---|
| `GitDrawer` | Desktop | ~¾ drawer, split SCM list + diff |
| `GitReview` | Mobile | Full-screen continuous review |

`DiffView` ceases to be the only shell; shared hunk/file UI stays in existing modules.

## Architecture

```
TerminalScreen / useTetherApp  (openDiff, summaries, stage/commit — largely unchanged)
        │
        ├─ isDesktop → GitDrawer
        │                 ├─ left: FileTree sections + CommitBox
        │                 └─ right: DiffLines | ImageDiff | empty state
        │
        └─ mobile     → GitReview
                          ├─ top: CommitBox (sticky)
                          ├─ Working tree: FileDiffSection… (Staged → Changes)
                          └─ History: list → DiffLines
```

## Desktop behavior (`GitDrawer`)

### Chrome

- Right-anchored panel ≈ **75%** window width (tunable). Terminal strip remains interactive.
- Close via explicit control and **Esc** when focus is in the drawer (commit field: Esc blurs/normal first; second Esc or close button dismisses). Outside-click-to-close is optional and deferred if it fights terminal focus.

### Left column (~⅓ of drawer)

- Tabs: **Working tree** | **History**.
- Working tree: **Staged** then **Changes** via `FileTree` (folder collapse; stage / unstage / discard).
- Sticky **CommitBox** at the **bottom** of this column (enabled when staged nonempty).
- File selection loads that path into the right pane: Changes rows → unstaged diff; Staged rows → staged diff (same semantics as today).

### Right column (~⅔ of drawer)

- Selected file: existing unified / side-by-side toggle when wide enough; hunk actions; image diffs.
- No selection: empty state (“Select a file”).
- History: commit list on the left; selected commit’s diff on the right (read-only).

## Mobile behavior (`GitReview`)

### Chrome

- Full-screen; Back returns to terminal.
- Tabs: **Working tree** | **History**.

### Working tree

- Sticky **CommitBox at the top**; scrollable review below.
- Continuous scroll order:
  1. Header **Staged (N)** + file blocks  
  2. Header **Changes (N)** + file blocks  
- Each file block: header (path, +/- stats or binary, file-level stage/unstage/discard) + chevron to **collapse/expand** hunks; body is unified `DiffLines` / `ImageDiff` with per-hunk stage/unstage. Side-by-side stays desktop/wide only — not in the continuous mobile feed.
- Default: files **expanded** on first open; collapsed set remembered for the session (until the view is dismissed).
- Progressive load: headers from summary immediately; diffs fill as parallel GETs complete (per-file spinner/error + retry). Concurrency capped (e.g. 4–6 in flight).

### History

- Commit list → tap opens that commit’s unified diff under the same chrome. No hunk actions.

## Data & errors

| Case | Behavior |
|---|---|
| No changes | Empty state in both shells |
| Single-file fetch fail (mobile) | Error + retry on that block; others unaffected |
| Truncated diff | Existing truncation banner |
| Commit fail | Existing notify; leave message text |
| Large change set | Parallel GETs + progressive UI; batch endpoint only if needed later |

## Testing

- Unit: file collapse state helper; Staged-then-Changes ordering; CommitBox enable rules.
- Component: `GitDrawer` split layout + terminal strip still present; `GitReview` both sections + top sticky commit; History still lists commits.
- Keep `diffModel` / hunk / `FileTree` tests; migrate `DiffView`-specific UI tests onto the new shells.

## Success criteria

- Desktop: open changes → drawer shows list | diff; terminal still visible and typeable in the remaining strip; commit from left column works.
- Mobile: open changes → continuous Staged then Changes diffs; collapse a file; stage a hunk; commit from the top bar.
- History works on both platforms without hunk actions on commit diffs.
- No intentional server API break; existing stage/unstage/discard/commit paths unchanged.
