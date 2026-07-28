# Server Settings drawer

Date: 2026-07-28
Status: designed

## Context

Spec 3 of three. See `2026-07-28-server-config-notifications-design.md` for the overall goal and the split.

Spec 1 made every tether server configurable over HTTP. Spec 2 made the client hold N hosts. This spec is the UI that closes the loop: each host's server-side settings are editable from the client, so adding a box never means SSHing into it to configure notifications.

Depends on both. Ships last.

## Dependency gap to close first

Spec 1 defines `GET`/`PATCH /api/config` and the three `/api/admin` routes, but **no test-send endpoint**. The notifications form needs one — "save an ntfy URL and hope" is not an acceptable setup experience, and the client cannot test it itself because the client is not the sender.

Add to Spec 1's surface:

```
POST /api/admin/test-notification   → sends a fixed test payload through the
                                      current (or supplied) notify config,
                                      returns { ok } or { ok: false, error }
```

It takes an optional config override in the body so the user can test before saving. Rate-limited like the other admin routes. No password required — it sends a harmless notification to an endpoint the caller can already read and rewrite.

## Structure

A per-host settings surface reached two ways: the gear on a host's drawer section header, and the host row in Config's Hosts screen. It is a full-screen modal on mobile and a panel on desktop, matching how `ConfigScreen` already presents.

Four sections, in this order:

1. **Identity** — name and color. These are Spec 1 config values (`identity.name`, `identity.color`), and they are what Spec 2's grouped drawer renders. Editing here changes the server's own idea of its name, so every client sees it; the local per-profile override in Spec 2's `hostStore` stays available for a client-side nickname.
2. **Notifications** — enabled toggle, ntfy URL, topic, token, per-trigger toggles (`waiting`, `oscNotify`, `exit`, `longJob`), and `longJobSeconds`. A **Send test** button calls the endpoint above with the current, possibly unsaved, form values and reports the result inline.
3. **Session defaults** — default shell, default cwd, scrollback rows, silence threshold (`session.*`). Changes apply to newly started sessions; the screen says so, because otherwise the absence of an effect on running sessions reads as a bug.
4. **Server** — change password, check for update, restart. Each is a confirmed, destructive-styled action.

## Form behavior

One local draft of the config, seeded from `GET /api/config` on open. Explicit Save (`PATCH` of only the changed keys) rather than save-on-blur — this is a remote machine, and an accidental keystroke should not reconfigure it. A dirty indicator, and a confirm on dismissing with unsaved changes.

Validation mirrors Spec 1's zod schema client-side so errors surface before the round trip; the server remains the authority and its rejection is displayed verbatim if the two ever disagree.

The token field renders from Spec 1's redacted `hasToken` boolean: "Token set" with a Replace action, never the value. Leaving it untouched omits the key from the `PATCH`, so saving other fields cannot clear it.

## Privileged operations

All three take the current password in the body per Spec 1, so each prompts for it in the sheet rather than assuming the stored one — this is a confirmation step, not an authentication shortcut. The stored password is never silently reused for these.

- **Change password** — current, new, confirm. On success, update that host's SecureStore entry. Existing tokens stay valid server-side, so the session does not drop.
- **Update** — shows current and available version, then runs. The daemon restarts, so the client shows "Updating…" and leans on Spec 2's health state machine to reconnect. Holders survive, so sessions return; the screen says that too, because "update the thing my shell is running on" otherwise looks reckless.
- **Restart** — confirm, fire, reconnect through the same path.

Each surfaces the failure verbatim. A failed update must not leave the UI claiming success — the version is re-read from the server after reconnect, and that value is what is displayed.

## Offline and error handling

The screen obeys Spec 2's per-host health. Opening settings for an `unreachable` host shows the last-known values read-only with a retry, not an empty form and not a spinner forever. `unauthorized` routes to the password prompt. A `PATCH` that fails leaves the draft intact so nothing typed is lost.

## Files

```
apps/mobile/src/ServerSettings.tsx        the screen
apps/mobile/src/serverSettingsModel.ts    draft/dirty/validation logic (pure)
apps/mobile/src/serverConfig.ts           typed client for /api/config + /api/admin
```

Modified: `SessionDrawer` (gear on the host header), `HostsScreen` (entry point), `hostStore` (identity name/color refreshed after a save).

## Testing

- **serverSettingsModel** — dirty tracking; a `PATCH` body containing only changed keys; the token field omitted unless explicitly replaced; validation matching the server schema; server rejection surfaced.
- **serverConfig** — request shapes for each route; the password lands in the body, never a URL or a log.
- **Component** — each section renders from a fetched config; Save issues one `PATCH`; test-send reports success and failure; an unreachable host renders read-only; unsaved-changes confirm on dismiss.
- **Privileged ops** — the password prompt appears for all three; a wrong password shows the server's error; after Update the version is re-read rather than assumed.

## Out of scope

- Remote log viewing (excluded in Spec 1, with reasons).
- Editing boot-time settings such as the listen port, which a running server cannot change for itself.
- Bulk-applying one host's settings to another. Obvious next step, but it needs a notion of which settings are portable, and that can wait for real use.
