# Settings: broken entry points & information architecture

Date: 2026-07-28
Status: designed

## Context

Specs 1–4 built per-host server settings and verified them statically — lint, typecheck, 28 component tests, all green. Running the desktop app against a live server found that **the screen is unreachable from its primary entry point**, plus two more defects that no static check could catch.

That is the lesson worth recording: the settings surface was verified but never driven.

This spec fixes the three defects, then restructures the settings information architecture, which is the underlying reason the surface felt wrong to use.

## Part 1 — The three defects

Found by driving the Tauri desktop build on `:1` against a throwaway server.

### 1. "Server settings" does not open

On the Hosts screen, pressing **Server settings** on a host card closes the Hosts screen and returns to the terminal. `ServerSettings.tsx` — 569 lines, fully tested — is unreachable this way. Trace `onServerSettings` from `HostsScreen` through `ConfigScreen` to `TerminalScreen`/`useTetherApp` and fix the wiring. The drawer's per-host gear must be verified to reach the same screen.

### 2. "+ Add host" does nothing

Pressing it produces no form, no row, and no navigation. `HostsScreen` calls `onAdd`, which `ConfigScreen` maps to `setHostsOpen(false)` followed by `onAddHost()`; the screen does not change, so either the press is not landing or `onAddHost` returns to the same view. Fix so it opens the pairing flow for a new host.

### 3. The colour picker intercepts clicks

Five swatches at roughly 72px sit permanently expanded on every host card and are the largest elements on the screen. A click aimed at the row beneath one landed on a swatch and silently changed the host's colour. Part 2 moves colour off the card entirely, which removes this class of error; until then it must not sit above other controls.

**Add a regression test for each.** Component tests that assert a press reaches its handler would have caught #1 and #2 — the existing suite tests the screens in isolation but never the paths between them.

## Part 2 — Information architecture

### The problem

Settings occupy three levels with no rule about what belongs where, and client-side and server-side settings are interleaved:

```
Connection settings        address · port · password · theme · font   (client)
  └─ Hosts                 list · colour · reorder · delete           (client)
       └─ Server settings  notifications · defaults · maintenance     (server)
Drawer host gear ──────────┘  (same destination, different path)
```

To change one machine's notification topic: gear → Manage hosts → find the row → Server settings. To change that same machine's password: gear → the top of a different screen. Same machine, two locations, no principle connecting them.

### The structure

Two levels, organised by **what is being configured** rather than by which process owns the setting:

```
Settings
├─ Hosts                       ← landing screen
│    ● homelab   192.168.50.30:8085   Connected
│    ● laptop    10.0.0.4:8085        Unreachable · retrying
│    + Add host
└─ Appearance                  ← theme, font (client-wide, host-independent)

Tap a host → one page, scrollable:
  Connection      address · port · password          (client)
  Name & colour   name · colour                      (client)
  Notifications   server · topic · triggers · test   (server)
  Sessions        shell · directory · scrollback · idle threshold  (server)
  Maintenance     change password · update · restart · remove host
```

Everything about one machine lives on one page. The drawer's host gear and the Hosts list both land there — one destination, so the ambiguity that produced defect #1 cannot recur.

### Host list rows

Each row carries only identity and status: drag handle, colour edge rule, name, address, health, chevron. No colour picker, no inline action row, no reorder chevrons at the far edge.

- **Reorder** is the drag handle beside the row it moves.
- **Delete** moves to the bottom of the host page as "Remove this host", away from a mis-tap. It still clears that host's SecureStore entry and cache entries.
- **Health** reads in words — `Connected`, `Unreachable · retrying`, `Needs password` — not a bare dot.

### Host page

Sections in the order above. Colour swatches drop to roughly 18px and sit inside the "Name & colour" section, so they cannot intercept a press meant for something else.

**Maintenance** is separated by a rule and tinted with `danger`, so the shape of the page shows where the irreversible actions are. Every behaviour from Spec 3 is preserved exactly: the current password is required in the body of all privileged operations and prompted for each time, the version is re-read from the server after an update, and the notify token is never round-tripped.

### Appearance

Theme and font move out of Connection settings into their own entry. They are client-wide and have nothing to do with any host — keeping them on a host-shaped screen is what made the first level incoherent.

## What does not change

Catppuccin palette, Fira Code, the `type.ts` scale, `motion.ts` and reduced-motion handling, `MIN_TOUCH_TARGET`. No new fonts, no new colours, no added animation. This is navigation and hierarchy, not a restyle.

All server contracts are untouched. This is a client-only change apart from nothing — `apps/server/` is not modified.

## Testing

- **Navigation** — from the Hosts list and from the drawer gear, the host page opens; "+ Add host" opens the pairing flow; every entry point reaches its handler. These are the regression tests for Part 1.
- **Host list** — rows render identity and health; reorder via the handle persists; no colour control is present on a row.
- **Host page** — every section renders; colour selection persists; Remove this host clears SecureStore and cache entries; Maintenance actions still prompt for the current password.
- **Preserved behaviour** — the Spec 3 test suite continues to pass unchanged in substance: token never round-tripped, per-op password prompts, version re-read after update, unreachable host renders read-only, unsaved-changes confirm.
- **Appearance** — theme and font persist from their new location.

## Out of scope

- The terminal surface and the session list inside the drawer.
- Any server-side change.
- Bulk-applying one host's settings to another.
