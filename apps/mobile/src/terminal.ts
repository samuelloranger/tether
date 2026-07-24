import { APP_THEMES } from './appTheme';
import type { LinkSpan } from './links';

// Shared terminal types + theme/palette state. The VT parsing engine now lives
// in ./terminalEngine.ts (a @xterm/headless adapter); this module keeps the
// render contract (RenderRow/CellStyle) and the mutable color palette both the
// engine and renderer read.

export interface CellStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
  caret?: boolean;
}

export interface RenderRun {
  text: string;
  style: CellStyle;
}

export interface RenderRow {
  // Stable identity of the underlying logical screen line. Monotonic per
  // engine; survives the line moving between screen and scrollback, so list
  // renderers can key on it instead of the array index (index keys shift by
  // one every time a line enters scrollback, remounting every visible row).
  key: number;
  runs: RenderRun[];
  // True when this row's logical line continues on the next row (soft-wrap, not
  // a real newline) — used to rejoin URLs split across the grid width.
  wrapped: boolean;
  // Link spans (column ranges → full URL) resolved across any soft-wrapped rows.
  links: LinkSpan[];
  // True when OSC 133;A (shell-integration prompt-start) marked this row.
  promptStart: boolean;
}

export let DEFAULT_FG = APP_THEMES.mocha.terminal.fg;
export let DEFAULT_BG = APP_THEMES.mocha.terminal.bg;

// The default Catppuccin Mocha ANSI palette, extended to xterm-256. Mutable:
// setTheme() below replaces BASE_16/PALETTE/DEFAULT_FG/DEFAULT_BG at runtime so
// an active session re-colors on its next repaint without a fresh engine.
let BASE_16 = [...APP_THEMES.mocha.terminal.base16];

function buildPalette(): string[] {
  const pal = [...BASE_16];
  const steps = [0, 95, 135, 175, 215, 255];
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) pal.push(`#${hex(steps[r])}${hex(steps[g])}${hex(steps[b])}`);
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    pal.push(`#${hex(v)}${hex(v)}${hex(v)}`);
  }
  return pal; // length 256
}

// btoa/atob are Latin1-only; decoding arbitrary clipboard text (which may
// contain multi-byte UTF-8) needs the decodeURIComponent trick below rather
// than TextDecoder, whose Hermes support is less consistently available
// across RN versions than atob/decodeURIComponent.
export function base64ToUtf8(b64: string): string {
  const latin1 = atob(b64);
  const percentEncoded = latin1
    .split('')
    .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return decodeURIComponent(percentEncoded);
}

export let PALETTE = buildPalette();

export interface Theme {
  base16: string[]; // exactly 16 ANSI colors
  fg: string;
  bg: string;
}

// Applies a theme — rebuilds the 256-color PALETTE from the theme's 16 base
// colors and swaps the default fg/bg used by cells with no explicit SGR color.
export function setTheme(theme: Theme) {
  BASE_16 = theme.base16;
  PALETTE = buildPalette();
  DEFAULT_FG = theme.fg;
  DEFAULT_BG = theme.bg;
}

// Mouse-reporting mode the app negotiated via DECSET 9/1000/1002/1003.
export type MouseMode = 'off' | 'x10' | 'normal' | 'button' | 'any';
