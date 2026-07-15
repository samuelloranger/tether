# Session ↔ preview banner

## Goal

Link an agent HTML preview to the terminal session that created it, and surface that link as a tappable banner in both directions on the mobile client:

- On a terminal session that has an open preview: a banner to jump to the preview.
- On a preview: a banner to jump back to the terminal session it came from.

Today a `Presentation` record has no session association at all — it's keyed by an agent-supplied `project` string, and every connected client auto-jumps to any newly created preview regardless of which session's agent created it. This spec adds the missing session link and uses it to scope that auto-jump and drive the new banners.

## Non-goals

- Desktop web/Tauri UI changes. `DesktopSessionNavigator` already lists sessions and previews side by side, so the discoverability problem this spec solves for mobile doesn't exist there.
- Any change to the `tether present` CLI surface (no new flag). The session link is inferred transparently; the agent and its skill instructions are unaffected.
- Handling more than one open preview per session in the banner UI (see Edge cases).

## Session → preview link

`pty.ts`'s `startSession` already builds an env object for each spawned shell (`withTermEnv(scrubAgentEnv(process.env))`, around `pty.ts:330`). It gains one more entry: `TETHER_SESSION_ID: sessionId`. Every process that runs inside that session's shell — the agent, and anything it shells out to — inherits it via normal fork/exec.

`presentCli.ts`'s `runPresent` reads `process.env.TETHER_SESSION_ID` and includes it as `sessionId` in the `/control/presentations` POST body, only for the `open` kind. `reset` stays session-agnostic (unchanged project-scoped semantics).

`presentations.ts`:
- `Presentation` gains an optional `sessionId?: string` — optional because a preview can still be created without one (manual testing, or a future non-CLI caller).
- `PresentationRegistry.create()` accepts and stores it on the internal record.
- `public()` includes it in the shape returned to clients.

`app.ts`'s `POST /control/presentations` passes `body.sessionId` through when it's a string, same pattern as the existing `project`/`title` handling.

## Auto-jump scoping

`useTetherApp.tsx`'s `refreshPresentations()` currently auto-selects (forces navigation to) any preview id it hasn't seen before, for every connected client. This changes to: auto-select only when `newPreview.sessionId === activeIdRef.current` — i.e., the client is currently looking at the terminal session that owns the new preview. Otherwise the preview is still added to `presentations` (so it appears in the drawer/nav and can drive its owning session's banner) but `activePresentationId` is left alone — no forced navigation for clients looking at a different session.

The existing fallback — clearing `activePresentationId` if the active preview disappears from the list — is unchanged.

This is a behavior change from what shipped in the original agent-html-previews feature (every client always jumped to every new preview), made possible now that a preview has a session to scope the jump to.

## Banner UX

**Terminal → preview** (mobile only, i.e. `!isDesktop`; desktop already surfaces this via `DesktopSessionNavigator`): a slim tappable banner between the header and the terminal grid, shown whenever `presentations` contains an entry with `sessionId === activeId`:

```
▢ Preview ready: "Creneau preview"          ›
```

Tap → `selectPresentation(id)`. It persists for as long as that preview stays open for that session — a standing affordance, not a dismissible toast.

**Preview → terminal**: a matching slim banner above `PresentationView`:

```
‹ Back to term-2
```

Tap → `selectTerminal(sessionId)`. Uses the owning session's display name from `drawerSessions` when resolvable, else the raw session id.

## Edge cases

- **Multiple open previews for the same session** (agent didn't reset before creating another): the banner shows the most recently created one. The others remain reachable from the drawer's preview list, just not from the banner. No dedicated multi-preview banner UI.
- **Session killed while its preview is still open**: the owning session disappears from `drawerSessions`. The "back to terminal" banner falls back to a generic "Back to terminal" that calls `selectTerminal(activeIdRef.current)` (whatever's already active) — harmless, since `switchTo` auto-starts a fresh session under a given id regardless.
- **Preview with no `sessionId`** (created before this feature shipped, or by a caller that didn't set one): never drives a "preview ready" banner on any terminal (nothing to attach it to), but stays reachable from the drawer/nav as today. If somehow made active, its "back" banner uses the same generic fallback as above.
- **Banner vs. existing preview-mode header chrome** (title/subtitle swap when `activePresentation` is set, shipped with the original feature): unaffected; the banner is additive, not a replacement.

## Testing

- `presentations.test.ts`: `create()` stores and returns `sessionId` when given one; omits it when not given.
- `presentations.api.test.ts`: POST `/control/presentations` with `sessionId` in the body round-trips it in the response and in `GET /api/presentations`.
- `presentCli.test.ts`: `runPresent` reads `TETHER_SESSION_ID` from `process.env` and includes it as `sessionId` when present; omits it when unset.
- pty env test (wherever `withTermEnv`/spawn env is currently tested): spawned session env includes `TETHER_SESSION_ID` matching the session's id.
- Mobile: a unit test (or inline coverage in the relevant test file) asserting auto-select only fires when `newPreview.sessionId === activeId`, and that a new preview for a different session updates `presentations` without changing `activePresentationId`.
- Manual: two terminal sessions; agent in session A runs `tether present`. Confirm A auto-jumps to the preview while B stays put and shows nothing until switched to. Confirm the "preview ready" banner appears on A's terminal view and the "back to term-A" banner appears on the preview view. Tap both directions.
