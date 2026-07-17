# Event-driven Git changes and syntax highlighting — design

Date: 2026-07-17

## Goal

Show the current Git working-tree change count for each live Tether terminal without polling. Every connected client for that terminal receives an immediate `+added / -removed` banner and can open the existing Git changes view. Both the changed-file diff and the regular file viewer render syntax-highlighted source.

## Decisions

- Git is the source of truth. The feature compares the working tree with `HEAD` using `git diff HEAD --numstat`, which combines staged and unstaged tracked-file changes. Untracked files are not included; they have no `HEAD` diff or meaningful line count.
- Tether watches the filesystem server-side. Codex and Claude Code hooks are not installed: they would miss editors, shells, other agents, staging, and commits.
- One terminal session owns one watcher. If its server-tracked live cwd changes to another Git root, the old watcher is closed and a new one is attached.
- Syntax highlighting uses `prism-react-renderer`, not a home-grown lexer. Language comes from the file path; unsupported languages remain selectable plain text.

## Server watcher and push flow

1. On a session's first known live cwd, resolve its Git root with the existing Git-root resolver. A non-repository has an empty summary and no watcher.
2. Create a recursive native `node:fs` watcher for the worktree and separately watch the resolved Git directory. The second watch covers staging, commits, branch changes, and linked-worktree metadata when `.git` is a pointer rather than a directory.
3. Coalesce watcher events for 150 ms. At the end of the burst, call the existing Git summary reader (`git diff HEAD --numstat`). Do not emit if the normalized file stats are unchanged from the last result.
4. Broadcast a new per-session WebSocket frame containing the summary to **all** subscribers of that terminal session. The initial subscriber receives the current summary immediately, so a client never waits for a filesystem event.
5. Close the watcher and clear its summary when the terminal exits, is killed, or moves to a different Git root. A failed watch or Git read degrades to an empty banner; it never interrupts terminal output.

The server already uses native file watching for presentation refreshes; Bun supports recursive `node:fs` watching, so this adds no runtime dependency.

## Client behavior

- Keep the pushed diff summary with the session state, so every live client, including a background tab, renders the same state.
- Show a compact, tappable `+N -M` banner only when the summary is non-empty. It opens the existing changed-files screen; no manual refresh control and no polling timer are added.
- The existing full-diff endpoint remains on-demand: only tapping a changed file fetches its unified diff.
- The banner is read-only. It does not expose staging, commits, discard, or arbitrary-ref comparisons.

## Syntax-highlighted viewers

Create one native code renderer shared by `FileViewer` and the per-file portion of `DiffView`. It receives source text, a path, and an optional diff line kind.

- `prism-react-renderer` tokenizes the source and returns token spans rendered as nested native `Text` nodes. The shared Catppuccin theme supplies colors for comments, strings, keywords, functions, numbers, punctuation, and plain text.
- Register only the common grammars used in this project/workflow: TypeScript/JavaScript, JSON, shell, HTML, CSS, Markdown, YAML, and Python. Unknown extensions use the current monospace plain-text renderer.
- A diff uses its selected file's path for language choice. File headers and hunk metadata stay muted. Context, addition, and deletion lines keep their normal/context, green, and red treatment respectively; syntax colors apply inside the source portion of those lines.
- The regular file viewer wraps source at the viewport edge. It renders original source lines separately and measures the requested line's rendered Y offset before scrolling, so terminal links still land on their exact source line despite variable wrapped heights. Diffs retain horizontal scrolling because side-to-side comparison is more useful there.
- Content remains selectable and capped by the existing 1 MiB server response limit.

## Dependency and bundle-size gate

`prism-react-renderer@2.4.1` is 173 KB as an npm tarball and 734 KB unpacked. It is the only syntax-rendering dependency; do not add a full editor, WebView, Shiki, or custom grammar implementation.

Before shipping, measure the production Expo web export and native release payload before and after adding the dependency and selected grammars. Record the exact delta in the implementation handoff. If it is disproportionate for a read-only viewer, stop and present the measurement before expanding grammar coverage.

## Verification

- Unit-test watcher debounce, unchanged-summary suppression, cleanup, root changes, and fan-out to multiple session subscribers using a temporary Git repository.
- Cover staged and unstaged edits, commit/stage metadata changes, and a non-Git cwd.
- Test banner visibility/counts and its navigation to the changed-files list for two client session states.
- Test language selection, syntax-token rendering, diff add/remove styling, and plain-text fallback without altering text content or line boundaries.
- Build the web export and native release target, then report the measured syntax dependency size delta alongside the existing typecheck and test suite.

## Out of scope

- Codex or Claude Code global hooks and a hook installer.
- Polling for Git changes.
- Untracked-file diffs, staging/committing/reverting from Tether, arbitrary refs, and a full source-editor experience.
