# Design

<!-- impeccable:design-schema 1 -->

## World

Graphite: true-black neutral chrome around a live PTY, night as the default scene. Nothing in the chrome competes with the terminal; one periwinkle accent marks only what you can switch or select. Every terminal colour scheme is a full-app palette; Tether's own is the default.

## Color

**The terminal theme colours everything.** The chosen terminal colour scheme sets the whole chrome palette, and whether the app is light or dark; there is no separate appearance setting. Tokens live in `TetherColors` (`clients/apple`) and `Tokens` (`clients/desktop`), both reading a `ChromePalette`.

**Tether** (the default) and **Tether Light** are the hand-set palettes: equal-channel greys, no tint, one accent. Light values are darkened so state words and faint text stay legible on white.

| Role | Tether | Tether Light |
|---|---|---|
| Background | `#000000` | `#F2F2F2` |
| Surface | `#141414` | `#FFFFFF` |
| Raised / selected | `#202020` | `#EBEBEB` |
| Border | `#2A2A2A` | `#DDDDDD` |
| Text | `#F2F2F2` | `#141414` |
| Secondary text | `#ABABAB` | `#5C5C5C` |
| Faint text | `#8D8D8D` | `#6A6A6A` |
| Placeholder | `#808080` | `#737373` |
| Accent | `#7C8CF8` | `#4353D0` |
| Terminal well | `#000000` | `#FBFBFB` |

Faint text measures at least 4.5:1 on the surface and background in both palettes; placeholder at least 4.5:1 on the input field.

**Accent is rare.** It appears only on toggles and switches, checkbox and radio marks, focus rings and selection (a selected row's check). The root tint is the text colour, so system Done, Cancel and back buttons read as text. A primary button is a text-colour pill with background-colour label.

**States are words and brightness, not colour.** Needs you: text colour, semibold, with a dot. Working: secondary text with a dot. Idle, done, ended: secondary text. Colour is for failures (danger or warning), diff additions and removals, usage at 80% or more, and an unhealthy connection.

**Every other theme derives its chrome** from its background, foreground and ANSI colours: surfaces and borders step from the background toward the foreground, the accent is the theme's blue, the state colours its green, yellow and red. A contrast guard lifts anything below 4.5:1 (3:1 for faint text) toward black or white, which keeps each state's hue. The well is the theme's background, so the terminal and its chrome read as one surface; Tether's own well is the chrome background for the same reason. `ChromePalette` holds the rules; a golden file keeps the Swift and Rust implementations identical.

## Typography

Chrome: system sans (platform UI). Mono only inside the terminal grid and code/diff/history surfaces. No mono costume on session titles or headings.

## Geometry

Soft, consistent radii (cards and sheets ~12, controls ~9–11), hairline borders, no shadows or glass. Status reads as a word beside a dot, not a pill badge. Section labels are sentence case in the UI font, never tracked caps. Status text uses the UI font; monospace is for paths, commands, keys and addresses. The utility key bar is a flat row; an armed Ctrl is a solid text-colour fill.

## Surfaces

- **Home:** segmented Machines / Keys tabs, rounded machine and key cards on the black background, empty state with a single primary action.
- **Add server / key entry:** underlined-feel inset fields, a password | private-key segment, a TOFU note ("first connect pins this host's key").
- **Terminal:** header with the machine + session and a status word with its dot, a left slide-over session drawer, git / history / send overlays that cover the grid.
- **Chat:** list and transcript share the drawer's chat rows: agent icon, title, state word.

## Components

### Agent-published transcript cards

Weather, image, and Docker cards extend the existing chat surface. They use the active theme's surface, border, and text roles; no independent card palette. Native platform sans remains the default, with SF Symbols on Apple and existing Slint controls on desktop.

- **Container:** full available transcript width, softly rounded corners (12), inset content (14), and a quiet border (0.5pt on Apple; 1px on desktop). A semibold title leads; source and fetch time remain visible in faint text below the content. Apple uses semantic SwiftUI type, with subheadline titles, caption metadata, and title-sized weather temperature; desktop uses its existing text hierarchy.
- **Weather:** lead with location, temperature with units, and conditions. Apple presents hourly forecasts in a horizontal strip; desktop stacks the forecast rows. Forecast times use the location's time zone. Missing temperatures read “Unavailable”; optional observations stay absent.
- **Images:** reuse the chat image preview and viewer, including zoom, save, and share. Keep caption/alt text with the image and show the existing placeholder when image bytes are unavailable. Desktop shares through Copy to share and original-file export; Apple uses its native share sheet.
- **Docker:** show the host and listed/healthy counts before container rows. Expand a row for its ID, CPU, memory, optional detail, and actions. Health and metrics that were not supplied remain explicitly unavailable; disclose partial lists. Apple action rows fall back to a vertical stack when horizontal space is insufficient.
- **Actions:** “Refresh”, “Show logs”, and “Request restart” submit readable requests into the conversation through the agent's normal permission flow. Apple uses semibold caption labels (12pt at the default text size) in `textPrimary` and a minimum 44 × 44pt frame **inside the button label**. Docker actions paint a compact rounded label inside that unpainted touch area, with a subtle accent tint and plain button style; weather retains its bordered style. Desktop reuses `SecondaryButton` with primary text and its existing hover/focus treatment. Disable actions when submission is unavailable or a request for the card is pending; show “Requested · see conversation” after submission rather than implying completion.
- **History:** updated cards retain their transcript position. Unsupported versions or kinds display their plain-text fallback. Reopening a card does not submit an action.

## Motion

Operate defaults: short state transitions only. No page-load choreography, no loops, no idle ambient movement. Tokens live in `TetherMotion` (`clients/apple`).

**Heat rises fast, cools slow.** The one motion idea: a session becoming live arrives on a decelerating curve (`working` 260ms / `waiting` 340ms), and a session going quiet lets go over 700ms. Equal durations would make two different events read as one. The curve is a confident deceleration, never a spring — an overshoot on a status colour reads as a second state change.

Supporting scale: 90ms touch feedback (`TetherPressStyle`: a 0.96 press scale on cards and chrome; on Mac a hover adds a faint raised fill), 200ms routine state change, 280ms overlay in. A screen arrives from just inside its final size (0.965 scale + fade), never by translating the whole view tree — that is fragile around UIKit and reads as theatrical on a terminal.

**Reduce Motion is a first-class path**, not a fallback: every travel collapses to a 120ms crossfade (Apple's own substitution for movement), with nothing that translates.

Never animated: the terminal grid, and any padding that changes its size. Walking the surface through intermediate heights makes it report grid sizes the PTY then has to honour.
