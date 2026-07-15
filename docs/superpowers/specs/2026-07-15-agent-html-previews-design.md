# Agent HTML previews

## Goal

Let any terminal-based coding agent show a generated HTML/CSS/JavaScript preview in Tether. The same workflow works for Codex CLI and Claude Code because it is a Tether command, not an agent API integration.

The feature is display-only. A page may be interactive locally, but it cannot return form values, events, or callbacks to the agent.

## User workflow

An agent working in a project creates a preview directory, then runs:

```sh
tether present ../creneau/preview/index.html --title "Creneau preview"
```

Tether opens the new preview for connected desktop and iOS clients. Changes below the preview directory refresh the open page automatically.

The command surface is:

```sh
tether present <entry.html> [--project <name>] [--title <title>]
tether present reset
tether present reset <project-name>
tether present agent-install [codex|claude]
```

`--project` defaults to the preview directory name. `reset <project-name>` removes every preview with that exact project key. A reset succeeds when no preview matches.

`agent-install` detects installed targets when none is supplied. It installs the selected target's global `tether-present` skill, which tells the agent when to generate a preview, invoke `tether present`, and reset it after the work is accepted or abandoned. It supports `codex` and `claude` as target names. The command is intentionally spelled `agent-install`; no misspelled alias is provided.

## Server design

### Presentation registry

The server keeps previews in an in-memory registry. A record contains a generated ID, title, project key, canonical preview root, canonical entry file, a random capability token, and a monotonically increasing revision.

Preview records are ephemeral: closing a preview deletes it and stops its file watcher; restarting Tether clears the registry. Persistence, history, and agent callbacks are out of scope.

### Local control endpoint

`tether present` sends its request to a dedicated local-control route using a random secret stored in a mode-0600 Tether state file. This is separate from the mobile app's shared password: an agent running as the server's local user can open a preview without receiving the user's mobile password.

The endpoint validates the entry file before registering it. It returns a direct error when Tether is not running or the file cannot be presented.

### Safe preview serving

The server exposes preview files below a presentation-specific capability URL. The app first gets preview metadata through its ordinary authenticated API; the renderer loads the capability URL, which needs no Authorization header for page subresources.

Every request is resolved with real paths and must remain below the canonical preview root. Missing files, path traversal, and symlinks that escape the root are rejected. The capability only serves that preview; it grants no Tether API access.

### Live refresh

The server watches the preview root and debounces a change batch into one revision increment. Clients poll the authenticated preview metadata alongside their normal state and reload a presentation whose revision changes. This avoids injecting reload code into user HTML and works with restrictive page CSPs.

## Client design

Terminals and previews are peer workspace entries.

- Desktop navigation keeps its chosen mode (sidebar, hover, or tabs) and adds a **Previews** section/entries beside terminal sessions.
- iOS exposes the same workspace choices, selects a new preview when it arrives, and returns to the previous terminal when that preview closes.
- Desktop web/Tauri renders a preview in an iframe. iOS renders the same capability URL in a native WebView.
- Every preview has a close action. Closing removes it for connected clients and tells the server to stop its watcher.
- Renderer load failures show a compact Retry / Close state.

The preview is isolated from Tether's native UI: there is no JavaScript bridge, message channel, or access to authenticated API credentials.

## Agent integration

Install a single focused skill for each requested CLI:

- Codex: user-scoped `tether-present` skill under the Codex user skill location.
- Claude Code: `~/.claude/skills/tether-present/SKILL.md`.

The skill is sufficient for discovery and invocation in both CLIs. No lifecycle hook is installed in v1: there is no automatic action that needs enforcement, and a hook would add trust/configuration surface without improving presentation delivery.

## Error handling

- Reject missing, unreadable, non-HTML, or out-of-root entry files with a clear CLI error.
- Reject unknown `agent-install` targets and unavailable requested CLI executables.
- Fail with a clear instruction when the server is not running.
- Reset removes matching previews atomically; no-match reset is harmless.
- A bad or unreachable preview page remains contained in its renderer error state; it cannot affect terminal connections.

## Verification

- Unit-test CLI parsing, project-name defaults, reset behavior, and agent-install target selection.
- Unit-test local control authorization, presentation lifecycle, capability URLs, canonical path containment, static asset serving, and debounced revision changes.
- Unit-test workspace navigation selection and preview close behavior.
- Run the existing TypeScript, test, web export, iOS export, Tauri build, and diff checks.
- Manually verify on desktop and an iPhone: present a page, load local CSS/JS/assets, edit a file and observe automatic refresh, then reset the project and all previews.

## Non-goals

- Agent callbacks, form-data collection, or bidirectional page messaging.
- Remote arbitrary URLs and arbitrary host filesystem access.
- Preview persistence across a Tether restart.
- Preview history, sharing controls, or hooks that act on agent lifecycle events.
