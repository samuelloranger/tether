# Git diff view v2 — staging, commits, history, side-by-side — design

Date: 2026-07-21

## Problem

The diff view (PRs #39/#40 + follow-ups) is read-only: it shows the working
tree against HEAD with a file tree, image diffs, and event-driven refresh.
Reviewing an agent's changes from the phone works, but *acting* on them does
not — you still need the terminal to stage, discard, or commit, and there is
no way to review what was already committed during the session.

## Goal

Turn the viewer into a lightweight review-and-commit tool:

1. **Stage / unstage / discard** — per file and per hunk.
2. **Commit from the app** — message + commit staged changes.
3. **Commit history browser** — recent log, tap a commit to view its diff.
4. **Side-by-side diff mode** — split rendering at desktop/tablet widths;
   unified stays the default on phones.

All server work reuses the existing trust anchor: the session's live cwd
resolved to its git root (`gitRoot.ts`), the same boundary the shell user
already controls. Same password auth as every `/api/*` route.

## Server API

All under `/api/sessions/:id/git/*`, root-resolved per request like the
existing diff endpoints, errors via `GitDiffError` (400/404) plus 409 for git
command failures (conflicts, nothing staged, etc.) with git's stderr as the
message body.

### Staging

- `POST .../git/stage` `{ path }` → `git add -- <path>` (covers untracked).
- `POST .../git/unstage` `{ path }` → `git reset -q HEAD -- <path>`.
- `POST .../git/stage-hunk` / `unstage-hunk` `{ path, hunkIndex }` →
  server re-reads the current unified diff for the file (`git diff` /
  `git diff --cached` for unstage), extracts the hunk at `hunkIndex`,
  synthesizes a minimal patch (headers + that hunk), and pipes it to
  `git apply --cached [-R] --unidiff-zero -`. If the file's diff changed since
  the client rendered (hunk count/offsets mismatch), respond 409
  `stale diff — refresh`; the client re-fetches. No patch-content round-trip
  from the client — the server only trusts its own git output.
- `POST .../git/discard` `{ path }` → tracked: `git checkout -q -- <path>`;
  untracked: `rm` the file (path validated against the root exactly like the
  file viewer). **Destructive** — the client must confirm before calling.

Path validation reuses the existing `validatePath` rules (no absolute paths,
no `..`).

### Summary split

`GET .../diff/summary` gains staged awareness: each file entry gets
`staged: boolean` (a path can appear twice when partially staged — once
staged, once unstaged), computed from `git diff --numstat` and
`git diff --cached --numstat`. The `diff` WS frame carries the same enriched
summary. Mobile `diffModel.ts` mirrors the field. This is an additive change;
files with the field absent render as before.

### Commit

- `POST .../git/commit` `{ message }` → `git commit -m <message>` (message
  passed as a single argv element, never through a shell). 409 with git's
  stderr when nothing is staged or hooks fail. Identity comes from the repo /
  global git config — if unset, git's own error surfaces as the 409 message;
  the app does not manage identity.

### History

- `GET .../git/log?limit=50` → `git log --format=%H%x00%h%x00%an%x00%aI%x00%s`
  parsed into `{ sha, shortSha, author, date, subject }[]`. Default 50,
  max 200.
- `GET .../git/commit/:sha/diff` and `.../commit/:sha/diff/file?path=` →
  `git diff-tree -p <sha>` (against first parent), same `MAX_DIFF_BYTES`
  truncation and image handling as the working-tree endpoints. `:sha`
  validated as `[0-9a-f]{4,40}`.

## Mobile / desktop UI

- **Diff screen sections.** File list splits into *Staged* / *Changes*
  groups (staged group hidden when empty). Each file row gets stage/unstage
  and discard actions (long-press menu on phone, inline icons on desktop).
  Discard shows a confirm dialog (the existing in-app alert modal).
- **Hunk actions.** Each hunk header gets a stage/unstage affordance wired to
  the hunk endpoints; on 409 the view silently refreshes and shows a toast.
- **Commit bar.** When staged files exist, a message input + Commit button
  pinned below the file list. Success clears the input; the diff frame refresh
  updates the list naturally (commit empties the staged group).
- **History tab.** Segmented control on the diff screen: *Working tree* |
  *History*. History lists commits (subject, shortSha, relative date); tapping
  one opens the same diff renderer fed by the commit endpoints, read-only.
- **Side-by-side mode.** Rendering concern only, no server change: when the
  pane width ≥ ~900px (desktop/tablet), a toggle enables split view. The
  parsed hunk model already pairs old/new line runs; render two aligned
  columns instead of interleaved rows, reusing the existing syntax gutter.
  Unified remains the default everywhere and the only mode below the width
  threshold. Preference persisted in the existing settings storage.

## Error handling

- Every git write op returns git's stderr on failure (409); the client shows
  it in the alert modal — no silent failures.
- Hunk staging races (file changed between render and tap) → 409 stale-diff →
  auto-refresh, as above.
- The existing `GitWatch` picks up index changes (`.git` dir is watched), so
  stage/unstage/commit from the app or from the shell both refresh every
  attached client's summary automatically.

## Testing

Server (bun test, temp repos on disk — pattern from existing gitDiff tests):

- stage/unstage file and hunk round-trips, including untracked files, renames,
  partial staging (same file in both groups).
- hunk index staleness → 409.
- discard tracked vs untracked; path traversal rejected.
- commit success / nothing-staged 409; message with quotes/newlines survives.
- log parsing; commit diff for merge and root commits (first-parent rule).

Client: diffModel grouping (staged/unstaged split), side-by-side row pairing
snapshots.

## Out of scope (YAGNI)

- Push/pull/branch operations.
- Interactive line-level (sub-hunk) staging.
- Commit message templates / AI-generated messages.
- Amend, rebase, stash.
