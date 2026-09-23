# Design

<!-- impeccable:design-schema 1 -->

## World

Aurora chrome around a live PTY: a periwinkle glow over a near-black base, night as the default scene. Home opens on an aurora-glow hero; the terminal is quiet chrome around the grid. Catppuccin flavors remain optional full-surface palettes; the terminal well is Mocha.

## Color

**Restrained.** Near-black neutrals plus one periwinkle accent, with a heat ramp reserved for session state. Tokens live in `TetherColors` (`clients/apple`); light values are darkened so state words stay legible on white.

| Role | Default dark | Default light |
|---|---|---|
| Background | `#08080E` | `#F1F1F6` |
| Surface | `#12121D` | `#FFFFFF` |
| Raised / selected | `#191926` | `#E9E9F2` |
| Border | `#232333` | `#DCDCE6` |
| Text | `#EDEEF6` | `#14141B` |
| Secondary text | `#9797AC` | `#5C5C6C` |
| Accent (primary) | `#7C8CF8` | `#4353D0` |

**Heat ramp** — what the active session is doing: `working` `#F2B34C`, `waiting` `#FF7050`, `done` `#6EE7A8`, cool/idle `#7C8CF8` (periwinkle, same as the accent). These drive the status lamp and state word.

**Terminal well:** `#1E1E2E` — this is fixed, not appearance-dynamic. It must equal the emulator's cell background (`TerminalPalette.background`) or a seam shows at the grid edge.

**System:** OS light → Default light; otherwise Default dark.

## Typography

Chrome: system sans (platform UI). Mono only inside the terminal grid and code/diff/history surfaces. No mono costume on session titles or headings.

## Geometry

Soft, consistent radii (cards and sheets ~12, controls ~9–11), hairline borders. Status reads as a tabular word beside a heat lamp, not a pill badge. The utility key bar is a flat row; an armed Ctrl is a solid accent fill.

## Surfaces

- **Home:** aurora-glow radial hero, segmented Machines / Keys tabs, rounded machine and key cards, empty state with a single primary action.
- **Add server / key entry:** underlined-feel inset fields, a password | private-key segment, a TOFU note ("first connect pins this host's key").
- **Terminal:** header with the machine + session and a heat status lamp, a left slide-over session drawer, git / history / send overlays that cover the grid.

## Motion

Operate defaults: short state transitions only. No page-load choreography, no loops, no idle ambient movement. Tokens live in `TetherMotion` (`clients/apple`).

**Heat rises fast, cools slow.** The one motion idea: a session becoming live arrives on a decelerating curve (`working` 260ms / `waiting` 340ms), and a session going quiet lets go over 700ms. Equal durations would make two different events read as one. The curve is a confident deceleration, never a spring — an overshoot on a status colour reads as a second state change.

Supporting scale: 90ms touch feedback (`TetherPressStyle`: a 0.96 press scale on cards and chrome), 200ms routine state change, 280ms overlay in. A screen arrives from just inside its final size (0.965 scale + fade), never by translating the whole view tree — that is fragile around UIKit and reads as theatrical on a terminal.

**Reduce Motion is a first-class path**, not a fallback: every travel collapses to a 120ms crossfade (Apple's own substitution for movement), with nothing that translates.

Never animated: the terminal grid, and any padding that changes its size. Walking the surface through intermediate heights makes it report grid sizes the PTY then has to honour.
