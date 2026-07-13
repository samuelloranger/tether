import { Platform } from 'react-native';

// The web bundle only ever runs inside the Tauri desktop shell (plain browsers
// can't authenticate the WS). So Platform.OS === 'web' means "desktop", and we
// use it to swap the mobile chrome (utility bar, overlay drawer, tap-to-type)
// for desktop conventions (physical keyboard, docked sidebar, mouse selection).
export const isDesktop = Platform.OS === 'web';

// macOS uses Cmd (not Ctrl) as the clipboard modifier, so Ctrl+C stays SIGINT.
// Detected from the webview UA since this only ever runs on the desktop build.
export const isMacDesktop =
  isDesktop && typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent);
