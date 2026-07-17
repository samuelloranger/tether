# Terminal file viewer — design

Date: 2026-07-16

## Problem

Terminal output often names source and documentation paths such as
`docs/superpowers/specs/2026-07-16-terminal-file-viewer-design.md` or
`apps/mobile/src/TerminalScreen.tsx:74`. Tether currently recognizes only
HTTP(S) links and sends them to the operating system. Inspecting a local file
therefore requires manually typing or copying the path into a shell/editor.

## Goal

Make workspace-relative file paths in terminal output clickable. Opening one
shows a native, full-screen, read-only source view inside Tether, with a clear
Back-to-terminal action. The server—not the client—enforces which files can be
read.

## User experience

- A path such as `docs/superpowers/specs/design.md` or
  `apps/mobile/src/App.tsx:42:9` is styled as a terminal link.
- Mobile opens it with a normal tap. Desktop opens it with Ctrl/Cmd+click, the
  same convention already used for web links.
- A full-screen `FileViewer` replaces the terminal, showing the workspace-
  relative path in its header, selectable monospaced content, and a Back action
  that restores the same terminal session and scroll position.
- A `:line` or `:line:column` suffix is not part of the requested filename; it
  scrolls the viewer to the requested one-based line. Column is displayed only
  when useful to the platform and does not require a horizontal caret UI.
- The viewer displays one read-only snapshot. It has no editor, file tree,
  syntax highlighter, search UI, refresh button, or file watch in v1.

## Link model

Replace the terminal renderer's string-only link target with a discriminated
target:

- `external` — existing HTTP(S) URL; preserve current behavior.
- `file` — a workspace-relative path plus optional line and column.

`links.ts` recognizes file-shaped tokens containing at least one path separator
and a filename extension, then strips trailing terminal punctuation and parses
an optional `:line[:column]`. This deliberately covers source, config, and
documentation files without turning arbitrary shell output into links.

`TermRow` delegates opening a target to the app rather than directly deciding
how every target opens. The app routes external targets to the existing opener
and file targets to the viewer flow. Wrapped terminal rows retain the complete
target exactly as existing web links do.

## Workspace security model

Each session records a canonical `workspaceRoot` when it is created: the
server's current working directory used to start that session. Store it with the
session record so it survives server reconnects and restarts.

The client sends only a relative file path and its latest OSC 7 terminal cwd as
an optional absolute base. The server validates that base lies beneath the
session's `workspaceRoot`, then resolves the requested path and verifies its
real path is still beneath the same root. The client can choose a subdirectory
within its own workspace but cannot expand access outside it.

Sessions created before this migration have no trustworthy workspace root. Their
file requests fail with a clear restart-session message rather than guessing a
root or widening filesystem access.

## API

Add an authenticated endpoint:

```text
GET /api/sessions/:id/file?path=<relative-path>&cwd=<optional-absolute-cwd>
```

On success it returns:

```json
{
  "path": "apps/mobile/src/TerminalScreen.tsx",
  "content": "import React from 'react';\n..."
}
```

The endpoint rejects malformed or escaping paths (`400`), sessions that need a
restart to obtain a workspace root (`409`), missing files (`404`), directories
or binary files (`415`), and text files larger than 1 MiB (`413`). It never
returns file contents in an error response. Symlinks are checked after
canonicalization, so a link from within the workspace to outside it is rejected.

## Client flow and errors

1. The user activates a file target.
2. The client requests the file with the active session ID, target path, and
   current emulator cwd when available.
3. While loading, the terminal remains visible with a lightweight loading
   overlay; it is replaced only after a successful response.
4. On success, `FileViewer` becomes the active full-screen content. On failure,
   the terminal remains active and the existing dialog/notification surface
   explains the outcome.
5. Back dismisses the viewer without changing the terminal session, socket, or
   scroll state.

The file viewer is separate from agent HTML presentations. It does not use a
capability URL or WebView and is not listed as a persistent preview tab.

## Verification

- Add server tests for allowed nested paths, `..` traversal, absolute-path
  rejection, symlink escapes, directories, binary detection, the 1 MiB limit,
  and legacy sessions without a workspace root.
- Add mobile unit tests for file-target parsing, punctuation trimming,
  line/column extraction, and soft-wrapped target reconstruction.
- Verify the existing HTTP(S) link behavior is unchanged.
- Manually verify a markdown and TypeScript file on mobile and desktop;
  Ctrl/Cmd+click desktop behavior; line jump; Back; a missing file; an outside-
  workspace path; and a symlink escape.

## Out of scope

- Editing, saving, uploading, deleting, or browsing arbitrary files.
- Syntax highlighting, minimap, in-view search, or live-reload.
- `file://` absolute URLs, arbitrary server paths, and any path outside the
  active session's recorded workspace.
