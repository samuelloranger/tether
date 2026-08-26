# iOS Aurora Visual Parity — Design

**Date:** 2026-08-26  
**Status:** Approved — implementing  
**Board:** #865  
**Source of truth (visual):** desktop Aurora in `apps/desktop` (`index.css`, `litTheme.ts`, `preferences.ts` default-dark / default-light)  
**Target:** native SwiftUI client under `clients/apple` (`TetherKit` + `TetherIOS`)

## Problem

Desktop shipped the Aurora visual language: activity-driven chrome tint (`--lit`), soft-depth session cards, heat-coded state, Inter + JetBrains Mono, and a full token set for dark and light. The native iOS app still uses a thin Catppuccin-ish `TetherColors` palette (Mocha/Latte) with no chrome-wide retint. The products no longer read as the same app.

## Goals

1. Port Aurora to iOS so dark and light chrome match desktop `default-dark` / `default-light`.
2. Drive chrome-wide lit tint from the **active** session’s activity, using the **same** classification as the session drawer badges.
3. Restyle **every** in-app surface (terminal chrome, drawer, utility/dpad, git, workspace, settings, pairing, password, presentations).
4. Keep iOS layout topology (drawer overlay, title bar, keyboard/utility bar) — restyle, don’t reinvent as a desktop sidebar.

## Non-goals

- Catppuccin / multi-flavor theme picker on iOS (Aurora defaults only).
- Shared cross-platform token package with desktop (deferred until flavors are shared).
- Changing Expo `apps/mobile` (legacy path).
- Redesigning terminal cell colours beyond matching the Aurora terminal well background.
- Making UIKit system chrome (status bar, keyboard, sheet grabbers) follow `--lit`.

## Locked decisions (brainstorming)

| Decision | Choice |
|---|---|
| Lit scope | **A** — full Aurora, chrome-wide retint |
| Surface scope | **C** — everything, pairing through settings |
| Appearance | **A** — Aurora dark + Aurora light |
| Flavors | **A** — Aurora defaults only |
| Approach | Mirror `litTheme` in pure Swift + `Environment` |
| Status strip | Fold into title bar / thin line under it — not a desktop-style floor under the PTY |

## Architecture

### Token set

Replace the current small `TetherColors` surface with the full Aurora chrome tokens, each resolved for dark and light. Hex values copy desktop `defaultDark()` / `defaultLight()` in `apps/desktop/src/preferences.ts` (keep in sync manually until a shared package exists).

**Chrome tokens:** `background`, `surface`, `surfaceRaised`, `input`, `text`, `textMuted`, `textFaint`, `border`, `overlay`, `selected`, `accent`, `accentText`, `success`, `warning`, `danger`, `info`.

**Terminal well:** `terminal.background` / `foreground` / `cursor` — the PTY backing stays the instrument face; it does not flip to light chrome in light mode (same rule as today’s fixed terminal background).

**Heat:** `working`, `waiting`, `cool` — darkened on light appearance so state words stay legible on white.

### Lit engine

New pure Swift module (name sketch: `LitTheme.swift`), port of `apps/desktop/src/litTheme.ts`:

1. Classify the active session with the **same** helper the drawer already uses (`SessionActivityLogic.dotKey` + recency).
2. Map dot → `LitState`: `working | waiting | idle | none` (`stopped` and missing session → `none`).
3. Resolve `lit` colour from heat (or `textFaint` for `none`).
4. Emit bloom alphas per state (waiting quieter than working; `none` zeroed) — same table as desktop `BLOOM`.

Root view observes active host/session + activity → publishes tokens + lit into the SwiftUI environment. Views read tokens only; no hardcoded Mocha/Latte at call sites.

### Fonts

- **Inter** (or Inter Variable if bundling allows) for chrome.
- **JetBrains Mono** for machine values and anywhere the terminal font is under our control.
- Bundle as app resources; do not rely on system installs.

## Chrome & layout

### Session drawer

- Soft-depth **cards** (~10–12pt corner radius, hairline border).
- **Active** row: lit-tinted fill, edge light, soft bloom.
- **Waiting but unselected**: quiet ember wash (desktop `.wants`) so “something wants you” works with the drawer open.
- Keep host colour affordance and address; activity colours come from Aurora heat.

### Title bar + status

- Aurora surface; state chip reads from `lit`.
- Fold desktop status-strip content into the title cluster or a single line under it: session id · relative last-output · state.
- Do **not** add a full status strip under the terminal (utility bar + keyboard already own that edge).
- Preserve ≥44pt tap targets.

### Terminal well

- Soft inset: rounded screen, rim glow from lit × bloom, terminal background = Aurora `terminal.background`.

### Utility bar / dpad

- Token backgrounds and borders; armed/active keys may use lit tint.

### Sheets & forms (git, workspace, settings, pairing, password, host list)

- Same token language: raised surfaces, eyebrow micro-labels (10pt / bold / wide tracking / uppercase / faint), accent-**tinted** primary buttons (not solid accent slabs), mono for machine values.
- Sheets use **static** tokens (no live lit strobe while a background session changes state). Lit continues to tint the chrome **behind** the sheet.

### Presentations

- Banner/panes on Aurora tokens; waiting affordances may use heat without retinting the whole sheet.

## Surface matrix

| Surface | Tokens | Live lit |
|---|---|---|
| Root / terminal chrome | yes | yes |
| Title bar + status line | yes | yes |
| Session drawer | yes | active + wants |
| Utility bar / dpad | yes | armed/active only |
| Git / review / history | yes | no |
| Workspace / file viewer | yes | no |
| App / appearance settings | yes | no |
| Server settings | yes | no |
| Pairing / host password / host list | yes | no |
| Presentation banner / panes | yes | heat accents only |

## Error handling & edge cases

- **No active session / stopped:** `LitState.none` — zero bloom, no warm/cool chrome tint.
- **Activity missing:** same fallback as drawer (`live` recency → working, else idle).
- **Light mode:** use desktop light heat (darkened); terminal well stays dark.
- **Reduced motion:** skip bloom/tint *animations*; still apply the target tint immediately.
- **Dynamic Type:** keep existing caps on the drawer width; don’t let Aurora radii break 44pt targets.

## Testing

1. **Unit:** Swift tests mirroring desktop `litTheme` cases — classification, `none` for stopped, bloom table, light vs dark heat resolution.
2. **Visual (simulator):** dark + light × idle / working / waiting / none; drawer with a waiting unselected row; sheet open while an unselected session flips waiting (sheet must not strobe).
3. **Regression:** existing `TetherKit` tests stay green; tap targets remain ≥44pt.

## Implementation sketch (not a plan)

Ordered for a later implementation plan:

1. Expand `TetherColors` (or replace with `AuroraTheme`) + heat + terminal well tokens.
2. Add `LitTheme` pure logic + tests; wire `Environment` from `RootView` / `SessionStore`.
3. Bundle Inter + JetBrains Mono; apply to chrome / mono call sites.
4. Restyle drawer, title bar + status fold, terminal well, utility/dpad.
5. Restyle sheets and forms screen-by-screen against the matrix.
6. Simulator visual pass; fix light-mode and wants-row gaps.

## Risks

- **System chrome seam:** status bar / keyboard / sheet chrome won’t take lit — accepted; only in-app chrome tints.
- **Token drift:** desktop hex values can change; without a shared package, iOS must be updated deliberately when Aurora defaults move.
- **Performance:** environment updates on every activity flip should be cheap (colour + opacity only); avoid rebuilding the terminal surface on tint alone.
