# Desktop terminal scrollbar

## Goal

Give the desktop terminal a subtle scrollbar that follows the active Catppuccin theme without changing the mobile interface.

## Design

Apply desktop-only CSS to the existing terminal scrolling element. Its track uses the terminal background and its thumb uses the theme's muted border color; hovering the thumb raises it to the selected-surface color. The scrollbar remains narrow and has a small radius.

Use both browser-native APIs:

- `scrollbar-width` and `scrollbar-color` for Firefox.
- `::-webkit-scrollbar` rules for the Tauri WebView/Chromium family.

The rule is scoped to the terminal DOM id so session navigation, previews, menus, and all mobile React Native views retain their current scrollbars. Theme values are supplied from the existing `useAppTheme()` result, so switching themes updates the scrollbar with the rest of the terminal.

## Error handling and testing

Browsers without either scrollbar API keep their native scrollbar. No state, network path, or input path changes. Verify with the existing web TypeScript/export checks and manually confirm each theme changes the terminal scrollbar while mobile remains unchanged.
