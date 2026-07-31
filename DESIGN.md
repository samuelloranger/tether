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

Operate defaults: short state transitions only (drawer enter/exit already present). No page-load choreography.
