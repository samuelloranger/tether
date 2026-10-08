# Design

<!-- impeccable:design-schema 1 -->

## World

Aurora chrome around a live PTY: a periwinkle glow over a near-black base, night as the default scene. Home opens on an aurora-glow hero; the terminal is quiet chrome around the grid. Every terminal colour scheme is a full-app palette; Tether's own is the default.

## Color

**The terminal theme colours everything.** The chosen terminal colour scheme sets the whole chrome palette, and whether the app is light or dark; there is no separate appearance setting. Tokens live in `TetherColors` (`clients/apple`) and `Tokens` (`clients/desktop`), both reading a `ChromePalette`.

**Tether** (the default) and **Tether Light** are the hand-set Aurora palettes: near-black neutrals plus one periwinkle accent, with light values darkened so state words stay legible on white.

| Role | Tether | Tether Light |
|---|---|---|
| Background | `#08080E` | `#F1F1F6` |
| Surface | `#12121D` | `#FFFFFF` |
| Raised / selected | `#191926` | `#E9E9F2` |
| Border | `#232333` | `#DCDCE6` |
| Text | `#EDEEF6` | `#14141B` |
| Secondary text | `#9797AC` | `#5C5C6C` |
| Faint text | `#8B8BA3` | `#8A8A9C` |
| Accent (primary) | `#7C8CF8` | `#4353D0` |
| Terminal well | `#1E1E2E` | `#FBFBFD` |

**Every other theme derives its chrome** from its background, foreground and ANSI colours: surfaces and borders step from the background toward the foreground, the accent is the theme's blue, the state colours its green, yellow and red. A contrast guard lifts anything below 4.5:1 (3:1 for faint text) toward black or white, which keeps each state's hue. The well is the theme's background, so the terminal and its chrome read as one surface. `ChromePalette` holds the rules; a golden file keeps the Swift and Rust implementations identical.

**Heat ramp:** what the active session is doing — `working` is the warning colour, `waiting` the danger colour, `done` the success colour, idle the accent. They drive the status lamp and state word.

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
