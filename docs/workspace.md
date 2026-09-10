# Git, files & previews

The git panel, file tree, uploads, and agent previews all follow the **active session's working directory** on the server. Pair and open a shell first; then these surfaces have somewhere to look.

## Git

Open the git panel from the toolbar (desktop) or the overflow menu (iOS). It has two tabs:

- **Changes** — unstaged and staged files in the session's repo. Stage or unstage a file or a hunk, discard, write a commit message, amend HEAD when that's safe (no upstream, or the local tip is ahead). Push and undo-last-commit are on the same surface; undo moves HEAD back one commit and leaves the changes staged.
- **History** — recent commits. Tap one to see its diff, including image diffs.

The panel tracks the live cwd, so `cd` into another repo (and wait for the prompt to redraw) and it follows. A session whose directory Tether cannot resolve shows an empty tree rather than the wrong repo.

## Files

The workspace navigator is a file tree rooted at the session's cwd:

- Tap a file to open it in the in-app viewer (syntax highlighting, images).
- Tap a path in terminal output to open that file the same way.
- Upload from the toolbar; on iPad you can also drop a file onto the terminal.

Uploads land in the session's current directory.

## Agent previews

Coding agents can push a watched HTML preview into the same navigator with `tether present`. See [Getting started](/getting-started#show-an-agent-preview) for the CLI and skill install. A banner ("Preview ready") appears on the session that opened it; tap to view. Previews are capability-scoped to their directory and vanish when the server restarts.
