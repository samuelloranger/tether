# Catppuccin app themes — design

## Goal

Give Tether a consistent, cross-platform light/dark appearance. The selected
Catppuccin flavor applies to every application surface and the terminal;
users no longer choose a terminal palette separately.

## Scope

- Supported choices are `System`, `Latte`, `Frappé`, `Macchiato`, and `Mocha`.
- `System` resolves to Catppuccin Latte when the OS is light. When it is dark,
  it resolves to the last explicitly selected dark flavor (Frappé, Macchiato,
  or Mocha), initially Mocha. It updates while the app is running when the OS
  appearance changes.
- An explicit flavor remains fixed regardless of the OS appearance.
- The selection applies immediately and persists across restarts.
- The feature must work identically in iOS, Android, and Tauri desktop builds
  for macOS, Windows, and Linux.

## Architecture

Create one app-theme module and provider. It owns:

- the persisted preference and safe parsing of its storage value;
- the persisted System dark-flavor preference and its safe parsing;
- the OS scheme supplied by React Native's cross-platform color-scheme API;
- resolution of `System` to a concrete flavor;
- semantic UI tokens for the resolved flavor; and
- the corresponding terminal foreground, background, and ANSI palette.

All UI components consume semantic tokens such as `background`, `surface`,
`surfaceRaised`, `text`, `textMuted`, `border`, `accent`, `danger`, and
`success`; they must not select colors by flavor themselves. This replaces the
current dark-only component-local colors with a single native/web-compatible
source of truth.

The token values come from the official Catppuccin flavors. Latte is the only
light flavor; Frappé, Macchiato, and Mocha are dark. Terminal ANSI colors use
the matching flavor rather than the retired Default, Dracula, and
Solarized-Dark palettes. The terminal emulator is updated when the resolved
flavor changes so existing sessions repaint without reconnecting.

## Interface and behavior

The existing Appearance modal replaces terminal-palette choices with the five
app-theme choices. Selecting a row updates the entire UI and terminal at once.
The existing desktop-only font picker remains below the theme choices.

The saved preference is independent of the resolved flavor: choosing `System`
stores `system`, not a concrete flavor. The last explicit dark selection is
stored separately for System; selecting Latte does not change it. Therefore a
later OS appearance change automatically uses Latte in light mode and the
remembered dark flavor in dark mode. If either storage value is unavailable,
missing, or unsupported, the app uses System with Mocha as its dark fallback
without blocking startup.

Text-entry surfaces set their native keyboard appearance from the resolved
flavor: light for Latte and dark for Frappé, Macchiato, or Mocha.

## Data migration

Reuse `tether_theme` for the app-theme preference. Existing values
(`default`, `dracula`, and `solarized-dark`) are unsupported by the new parser
and safely resolve to `System`; the next user selection overwrites the key.
Persist System's remembered dark flavor under `tether_system_dark_theme`; an
absent or invalid value becomes Mocha. This intentionally avoids guessing
whether a prior terminal-only palette should become an application-wide theme.

## Verification

- Unit-test parsing and resolution of each explicit flavor, System→Latte in
  light mode, System→each remembered dark flavor in dark mode, live OS-scheme
  changes, and invalid/missing storage fallback.
- Unit-test the resolved terminal palette contract for all four flavors.
- Update terminal tests that currently assert the retired palette choices.
- Run mobile tests, TypeScript checking, lint, and web export. The web export
  validates the shared UI used by Tauri desktop builds.
- Manually verify System and every explicit flavor on iOS, Android, and a
  Tauri desktop build. Verify terminal output, connection/setup screens,
  drawers, menus, modals, inputs, and native keyboard contrast.

## Non-goals

- No per-component custom themes.
- No additional theme dependency.
- No user-editable color editor.
- No separate native and web theme systems.

## Reference

- [Official Catppuccin palette](https://catppuccin.com/palette/)
