# Server-tracked live cwd + git diff view — design

Date: 2026-07-17

## Problem

PR #38 (`feat: open terminal file links in-app`) gave each session a
`workspace_root`, but it's captured once — `realpathSync(process.cwd())` at
session start (`pty.ts`) — which is the **daemon's** launch directory, not
wherever the shell actually navigates to afterward. When a user `cd`s into a
Claude Code or Codex project outside that root, file links 400 as
"escapes workspace" even though the shell itself is sitting right there. The
only per-request flexibility today is a client-supplied `cwd` query param,
which can't be trusted as an authorization boundary — it comes from the
mobile client's own OSC7 parsing of the byte stream, not from the server.

Separately, there's no way to review the accumulated edits an agent (Claude
Code, Codex, or anyone) makes to a workspace over a session — only single
files, one at a time.

## Goal

Replace the frozen `workspace_root` with a live cwd the **server** tracks
authoritatively per session, resolve it to the nearest git repo root on every
request, and use that as the trust anchor for both the existing file viewer
and a new git diff view — so reviewing what an agent changed is as easy as
tapping a link.

## Live cwd tracking

`pty.ts` already injects `tether.bashrc` for the prompt, and the comment at
`shellInvocation` already notes OSC 7 cwd tracking is wired per-shell
(bash/zsh/fish) — today purely so the mobile emulator can display/relay a
`cwd`. The gap is that only the *client* parses it; the server just forwards
bytes.

Change: parse the same OSC 7 sequence (`\x1b]7;file://host/path\x1b\\`)
**server-side**, in the same pipe that already does `addTerminalLog` /
broadcast, and store the parsed path as an in-memory `liveCwd` per session
(not persisted — it's re-asserted on every prompt, so nothing to recover
after a restart beyond waiting for the next prompt). Ensure the injected rc
emits it eagerly on shell init (first `PROMPT_COMMAND`/`precmd` firing before
any user input), so `liveCwd` is known immediately rather than only after the
first `cd`.

This mirrors the client's own OSC7 handling but is authoritative: the escape
sequence originates from the PTY process the server itself spawned for this
session's authenticated owner, not from the network client. That's the
correct trust boundary — the user could already `cat`/`vim` anything in that
directory tree from the same shell.

## Root resolution

Given `liveCwd`, resolve the boundary per request:

```text
root = git -C <liveCwd> rev-parse --show-toplevel, or <liveCwd> itself if not a repo
```

Recomputed on every request (cheap, no caching needed) rather than snapshotted
— so a `cd` into a different project between requests is picked up
immediately, and there's no "restart terminal" legacy state to special-case.

## Security model

- Never accept a client-supplied `cwd`. The server already knows it.
- The requested file `path` is still validated by the exact containment logic
  already in `workspaceFile.ts` (`realpathSync` + `inside()`, `..`/absolute
  rejection, symlink-escape check after canonicalization, binary/size caps) —
  just checked against the freshly-resolved root instead of a frozen column.
- The diff route needs no separate escape check: `git -C <root> diff` is
  inherently scoped to the repo at `root`; git itself won't diff outside its
  own working tree.
- `sessions.workspace_root` (PR #38's column) becomes unused for
  authorization. Leave the column or drop it in a follow-up migration — not
  load-bearing either way once this lands.

## API

```text
GET /api/sessions/:id/file?path=<relative-path>
```

Unchanged response shape; `cwd` query param removed (server supplies root).

```text
GET /api/sessions/:id/diff/summary
```

Lightweight poll target — `git -C <root> diff --stat` (or equivalent
porcelain), used to decide whether a "View changes" affordance should show
and to list changed files without fetching full content.

```text
GET /api/sessions/:id/diff?path=<optional-relative-path>
```

Full unified diff — `git -C <root> diff [-- <path>]` when `path` is given,
whole-repo diff otherwise. Diffs against the working tree vs `HEAD`
(`git diff HEAD`, i.e. staged + unstaged combined) — matches "what has
changed since I started looking," not a specific ref comparison. Apply the
same size cap philosophy as the file route (e.g. 1 MiB, with a `truncated:
true` flag rather than silently cutting content) so a huge diff can't wedge
the client.

All three routes require the same session-password auth as everything else
under `/api/*`.

## Client flow

- A "View changes" header action appears when `diff/summary` reports a
  non-empty diff (or simply lives next to the existing overflow menu,
  cheap to poll).
- Tapping it shows a changed-files list (from the summary) reusing
  `FileViewer`'s themed, monospace, read-only rendering style; tapping a file
  fetches and shows its diff.
- Same navigation contract as `FileViewer`: replaces the terminal view, Back
  restores it without touching socket/scroll state, mutually exclusive with
  `activePresentation`/`fileView` (folds into the existing `terminalVisible`
  branching in `TerminalScreen.tsx`).
- Poll-based by default (both Claude Code and Codex covered identically,
  since this is git-diff, not tool-hook, driven). Optional phase 2: a Claude
  Code `PostToolUse` hook on `Edit|Write|MultiEdit` pings the server to
  shorten next-poll latency — a notification nicety, never the source of
  truth, and not required for Codex parity since there's no equivalent hook
  surface there yet.

## Verification

- Server unit tests: git-root resolution for a nested cwd, a non-repo
  fallback, and (if cheap) a worktree; OSC7-in-byte-stream parser tests
  (partial escape split across chunks, multiple `cd`s in one write); diff
  route auth + size-cap tests.
- Mobile unit tests: changed-files list rendering, diff text rendering,
  navigation mutual-exclusion with presentations/file view.
- Manual: `cd` into a project outside the daemon's launch directory (e.g. a
  Claude Code / Codex working dir under a different parent) and confirm both
  file links and the diff view work there — the scenario that's broken today.
- Manual: edit a file with an agent mid-session, confirm it shows up in
  `diff/summary` and the per-file diff without restarting the terminal.

## Out of scope

- Staging, committing, reverting, or discarding changes from the UI — read
  only, same philosophy as `FileViewer`.
- Diffing against arbitrary refs/branches — `HEAD` vs working tree only.
- Multi-repo or submodule-aware diffing.
- Real-time push on every keystroke — polling `diff/summary` is the v1
  latency model; the optional hook ping is the only push mechanism.
- Removing the `workspace_root` column/migration itself (noted as a
  follow-up, not required for this feature to work).
