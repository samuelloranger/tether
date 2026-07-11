# Tether Trust, Recovery & Honesty Redesign — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorm), pending spec review
**Audit source:** `DESIGN-IS-2026-07-11/` — scored 16/30, verdict REDESIGN
**Board tasks:** #156 (security), #157 (verifiable setup), #158 (destructive/scope disclosure), #159 (weight)

## Problem

A Rams-principle design audit scored Tether's mobile experience 16/30. The two
load-bearing dimensions both scored 1/3:

- **#6 Honest (1/3)** — the server exposes an unauthenticated shell to anyone who
  reaches the port; several labels overclaim safety (`Process is preserved safely
  on the host`), scope (`Copy All`, `Search output` operate only on the displayed
  transcript), and status (`Syncing…` shown while the socket merely opens); a
  drawer Kill deletes a process and all its logs with no confirmation.
- **#4 Understandable (1/3)** — first-run setup drops the user into an unverified
  terminal with only an indirect recovery path; tap-to-type and long-press-to-select
  are hidden; the first-connect `Reconnecting…` banner appears before any connection
  ever succeeded.

Supporting failures: white-on-`#4f46e5` action text is 3.83:1 (below WCAG AA);
the caret blinks every 530 ms ignoring reduced-motion; the hidden capture
`TextInput` is not excluded from the accessibility tree; one dead `React` import.

## Goals

1. **Honest** — every security, status, and data-retention statement maps precisely
   to implementation; risk is visible before action.
2. **Understandable** — setup makes address format, auth, success, and failure
   recovery self-evident without terminal-app tribal knowledge.
3. **Useful** — a self-hoster can diagnose and repair a connection failure directly
   from the current screen, then reach a live terminal in the fewest safe steps.

## Non-goals

- Building TLS/WSS into the server. Rejected during brainstorm as too heavy and
  fragile on iOS (self-signed cert + WebSocket needs a native module with poor
  WebSocket support). **Encryption is delegated to the deployment tunnel.**
- Desktop/tablet layout, AltStore install flow, light theme.
- Rewriting the terminal emulator, multi-session model, or key layer (preserved).

## Preserve (do not touch)

- Terminal-first layout: VT grid as the flexible center inside compact dark chrome.
  `apps/mobile/App.tsx:855-961`
- Mobile key layer: Ctrl, Tab, Esc, Del, arrows, Home/End, PgUp/PgDn, paste,
  keyboard dismissal. `apps/mobile/App.tsx:1180-1244`
- Brand tokens: near-black `#05070e`, slate `#0b0f19`, indigo family, cyan `#22d3ee`,
  Fira Code. (Indigo action background is retuned for contrast — see Track D.)
- Persistent detached shells, replay, LRU tab cache.

---

## Decisions (from brainstorm)

- **Auth model:** single shared password (not user/pass). Server-side hashed.
- **Transport encryption:** delegated to a tunnel (Tailscale / WireGuard / SSH).
  The app never claims the password encrypts traffic.
- **Cert/TLS:** none built in.
- **Credential storage:** client stores the password in `expo-secure-store`,
  persisted by default (no "remember me" toggle).

---

## Track A — Auth trust boundary (#6 Honest, task #156)

### Server (`apps/server`)

- **Credential store.** New server config value `auth_password_hash` (argon2id via
  Bun's `Bun.password.hash` / `Bun.password.verify`). Lives in `config/` alongside
  the DB, gitignored. Absent hash ⇒ server logs a loud warning and (see cutover)
  refuses authed routes rather than silently running open.
- **CLI.** `tether set-password` prompts (no echo), writes the hash. Added to
  `apps/server/cli.ts`.
- **Auth gate.** A Hono middleware in `app.ts` runs before every route and the WS
  upgrade. It reads `Authorization: Bearer <password>`, verifies against the stored
  hash, and returns `401` (JSON `{ error: 'auth' }`) on mismatch/absence.
  - Applies to: `GET /api/sessions`, `GET /api/ws`, logs, `POST /api/sessions/kill`,
    restart, and any future route. No allowlist except `GET /api/health` (see Track B),
    which is *also* authed so a wrong password is detectable at test time.
- **WS auth.** The upgrade handler validates the header before `startSession`.
  A failed WS auth closes with code `4401` (app-defined) so the client can
  distinguish auth failure from network drop.
- **Bind/CORS unchanged.** `0.0.0.0` + permissive CORS remain (tunnel deployment),
  but `index.ts` startup logging states the posture explicitly: whether a password
  is set, and that traffic encryption is the tunnel's responsibility.

### Client (`apps/mobile`)

- **Pairing.** Setup screen adds a password field. On save, the password is written
  to `expo-secure-store` (key `tether.password`), never to AsyncStorage/plaintext.
- **Header auth.** All requests carry the header:
  - `fetch`: `Authorization: Bearer <password>`.
  - WebSocket: `new WebSocket(url, [], { headers: { Authorization: 'Bearer ' + pw } })`
    — RN supports the options arg; keeps the secret out of the URL and server logs.
- **Auth-failure state.** WS close `4401` or HTTP `401` ⇒ a distinct **"Wrong password"**
  state with a direct **Edit** action, not the generic offline/reconnecting banner.

### Honesty copy (setup)

> Password controls **access**. For traffic **encryption**, run tether behind a
> tunnel (Tailscale, WireGuard, or SSH).

---

## Track B — Verifiable setup + recovery (#2/#4, task #157)

### New primary flow

```
Setup ──▶ [Test connection] ──▶ result
             │                    ├─ Reachable ✓        ──▶ Save ──▶ Terminal
             │                    ├─ Unreachable         ──▶ stay, show host/port hint
             │                    ├─ Wrong password      ──▶ stay, focus password
             │                    └─ Invalid address     ──▶ stay, inline field error
```

Contrast with current flow: today, Save transitions straight into an unverified
terminal; the only recovery is buried in the drawer. `apps/mobile/App.tsx:824-850`,
`apps/mobile/App.tsx:908-973`.

### Changes

- **`GET /api/health`** — new lightweight authed route returning `200 { ok: true }`.
  Cheap reachability + auth probe. Authed so it also validates the password.
- **Test connection action** on setup. Distinguishes four outcomes above by
  status code / fetch error:
  - fetch network error ⇒ *Unreachable — check host and port.*
  - `401` ⇒ *Wrong password.*
  - non-parseable host/port ⇒ *Invalid address* (inline, before any request).
  - `200` ⇒ *Reachable ✓* and enables Save.
- **First-connect state fix.** Remove the misleading `Reconnecting…` on a
  never-connected socket. State machine:
  - never connected yet ⇒ **Connecting…**
  - was `open`, then dropped ⇒ **Reconnecting…**
  - auth failure ⇒ **Wrong password** (Track A).
  Track a `hasConnectedRef` to gate which banner shows.
  `apps/mobile/App.tsx:353-364`, `apps/mobile/App.tsx:883-914`.
- **Direct Edit-connection action** reachable from the terminal/offline screen
  (header or offline banner), so repair never requires opening the drawer.
- **Inline address hint** on the host field (expected format / example).

---

## Track C — Honest copy + destructive disclosure (#6/#8, task #158)

### Copy renames (scope honesty)

| Current | New | Why |
| --- | --- | --- |
| `Copy All` | **Copy displayed transcript** | operates on local grid+scrollback, not server history. `App.tsx:613-653` |
| `Search output` | **Search displayed transcript** | same local scope. `App.tsx:621-631` |
| `Syncing…` | **Connecting…** | shown while socket opens, not during replay sync. `App.tsx:353-364,883-914` |
| `Reconnecting… Process is preserved safely on the host.` | **Reconnecting… (session kept running on the server)** | drops the absolute safety guarantee a missing holder can't uphold. `pty.ts:158-163,232-266` |
| `Snippets` | **Saved commands** | plainer for the audience. |

### Destructive-action disclosure

- **Kill (drawer).** Currently deletes process + session row + logs with **no
  confirmation** (`SessionDrawer.tsx:141-149`, `pty.ts:325-342`). Add a confirm
  dialog: *"Kill this terminal? The process and its saved output will be deleted.
  This can't be undone."* Confirm / Cancel.
- **Restart.** Already confirmed, but does not disclose history loss
  (`App.tsx:748-772`). Update copy: *"Restart clears this terminal's scrollback
  history."*

---

## Track D — Details, accessibility, weight (#4/#8/#9, task #159)

### Contrast (WCAG AA)

- White-on-`#4f46e5` = **3.83:1**, fails AA for the 14px Connect and 13px New-terminal
  labels (`App.tsx:1347-1357`, `SessionDrawer.tsx:211-221`). Darken the indigo action
  background to a shade giving **≥4.5:1** with white text (target `#3730a3`-class;
  exact value chosen against a contrast check during implementation). Applies to all
  primary action buttons using this token.

### Reduced motion

- Caret blinks every 530 ms unconditionally (`App.tsx:255-259`). Gate on
  `AccessibilityInfo.isReduceMotionEnabled()` (+ change subscription): reduced-motion
  ⇒ steady (non-blinking) caret. Drawer already respects the preference.

### Terminal accessibility

- Add an accessible label to the terminal press target describing behavior:
  *"Terminal. Double-tap to type, long-press to select text."* `App.tsx:848-850`
- Exclude the hidden capture `TextInput` from the a11y tree:
  `accessibilityElementsHidden` (iOS) + `importantForAccessibility="no-hide-descendants"`.
  `App.tsx:1246-1262`
- Add missing `accessibilityRole`/labels on utility bar + modal rows.
  `App.tsx:925-960`, `App.tsx:984-1032`

### Missing states & dead code

- **Empty terminal state.** Minimal placeholder before first output arrives
  (currently blank — `App.tsx:1083-1086`).
- **Dead import.** Remove the default `React` import in `SessionDrawer.tsx:1`.

### Weight (#159, P2 — Feather-only icon trim)

- Baseline (audit): iOS export bundled 20 font assets although the UI uses only
  Feather icons.
- Import icons from `@expo/vector-icons/Feather` (or load only the Feather font)
  so the other icon-font `.ttf` families don't ship in the bundle.
- No on-device cold-start measurement in this spec — trim only. Fira Code stays
  (blank-until-loaded is a separate, accepted tradeoff for this release).

---

## States checklist (per audit handoff)

| State | Where covered |
| --- | --- |
| empty terminal | Track D |
| loading / connecting | Track B (Connecting…) |
| unreachable host | Track B (Test connection) |
| invalid address | Track B (inline) |
| authentication failure | Track A (Wrong password / 401 / 4401) |
| connected | existing |
| reconnecting | Track B (only after a real connection) |
| success | Track B (Reachable ✓ → Save) |
| focus | Track D (a11y labels/roles) |
| disabled | Save disabled until Test passes (Track B) |
| destructive confirmation | Track C (Kill, Restart) |

## Migration & cutover

- **Existing stored config.** Users already have host/port in AsyncStorage.
  On upgrade with no stored password, the client routes to setup with host/port
  prefilled and prompts for the password (server now requires it).
- **Server cutover.** Server with **no** `auth_password_hash` refuses authed routes
  and logs `set a password with 'tether set-password'`. This retires the open-shell
  default — there is no "run unauthenticated" happy path. (A deliberate escape hatch
  can be an env var, but it is off by default and out of scope for this spec.)
- **Retire** the old direct host/port→terminal transition once Test-connection is
  the save gate.

## Testing

Repo has no test runner for UI; existing unit tests use custom `eq`/`pass` helpers
run via `bun test` from `apps/mobile`, plus `apps/server` typecheck.

- **Pure/unit (testable now):**
  - address validation (valid/invalid host+port parsing).
  - connection-state reducer: never-connected→Connecting, open→drop→Reconnecting,
    auth-fail→WrongPassword.
  - server auth middleware: 401 without header, 200 with correct password, 401 with
    wrong password (server-side test).
- **Manual on-device (no simulator in env):** Test-connection four outcomes, Kill/
  Restart confirmations, VoiceOver over terminal + hidden field exclusion, reduced-
  motion caret, contrast on action buttons.

## Open questions

None blocking. Exact darkened-indigo hex and the empty-terminal placeholder copy
are finalized during implementation against a contrast check / design pass.
