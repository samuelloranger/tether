# Design

<!-- impeccable:design-schema 1 -->

## World

Instrument bezel chrome around a live PTY. Night is the default scene. Catppuccin themes remain optional full-surface palettes.

## Color

**Restrained.** Neutrals plus one accent.

| Role | Default dark | Default light |
|---|---|---|
| Background | `#0B0C0F` | `#F4F5F7` |
| Surface | `#12141A` | `#FFFFFF` |
| Raised / selected | `#1A1D24` | `#ECEEF2` |
| Border | `#2A2E38` | `#D5D7DE` |
| Text | `#E8EAEF` | `#0A0A0B` |
| Accent (armed / primary) | `#3DDC97` | `#0B7A4B` |
| Info / host rail default | `#4D8DFF` | `#002FA7` |

Catppuccin Latte / Frappé / Macchiato / Mocha keep their existing mauve-accent palettes from `appTheme.ts`.

**Terminal well:** Default dark → Mocha; Default light → Latte. Catppuccin themes couple chrome and terminal as before.

**System:** OS light → Default light; otherwise Default dark.

## Typography

Chrome: system sans (`Helvetica Neue` / platform UI). Mono only inside the terminal grid and code/diff surfaces. No Courier costume on session titles.

## Geometry

Tight radii (`SURFACE_RADIUS`: control 2, panel 4, hero 0). Hairline borders. Status as a tabular word with a left rule — not pill badges. Utility keys are a flat hairline row; armed Ctrl is solid accent fill only.

## Surfaces

- **Connect:** left-aligned wordmark, hairline rule, underline fields, no `>_` icon card.
- **Session drawer:** 2px host color rail; flat rows; outlined New terminal.
- **Title / mobile header:** status word (`online` / `connecting` / `offline` / `auth`).

## Motion

Operate defaults: short state transitions only. No page-load choreography, no loops, no idle ambient movement.

**Heat rises fast, cools slow.** The lit chrome's one motion idea: a session becoming live (`working` 260ms / `waiting` 340ms) arrives on a decelerating curve; a session going quiet (`idle` / stopped) lets go over 700ms. Equal durations would make two different events read as one. Tokens: `TetherMotion` (`clients/apple`); on desktop the same curve is one transition on `.app-shell`, made possible by registering `--lit` / `--b1..--rim` with `@property` so the tint is an interpolatable type rather than a string — every tinted surface crossfades from one declaration. `data-lit` carries the state being entered and picks the duration.

**One authored moment:** a single non-repeating swell of the bloom when a session enters `waiting`. It fires only on entry, never loops, and never under Reduce Motion.

Supporting scale: 90ms touch feedback, 200ms routine state change, 280ms overlay in / 200ms out (exit is faster than entrance). Colour changes crossfade; gradients crossfade by layer, since their colours do not interpolate.

**Reduce Motion / Reduce animations is a first-class path**, not a fallback: every travel (drawer slide, key-bar slide, pill scale, D-pad spring, viewer push) collapses to a 120ms crossfade, and the waiting swell is suppressed. Feedback that is colour rather than movement — a lit key face — stays.

Never animated: the terminal grid, and any padding that changes its size. Walking the surface through intermediate heights makes it report grid sizes the PTY then has to honour.
