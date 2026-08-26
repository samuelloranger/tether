export type ThemePreference = 'dark' | 'light' | 'mocha' | 'macchiato' | 'frappe' | 'latte';

export type TerminalFont =
  | 'JetBrains Mono'
  | 'Fira Code'
  | 'IBM Plex Mono'
  | 'Source Code Pro'
  | 'monospace';

const THEME_KEY = 'tether.desktop.theme';
const FONT_KEY = 'tether.desktop.terminalFont';

export interface AppPreferences {
  theme: ThemePreference;
  terminalFont: TerminalFont;
}

export const TERMINAL_FONTS: TerminalFont[] = [
  'JetBrains Mono',
  'Fira Code',
  'IBM Plex Mono',
  'Source Code Pro',
  'monospace',
];

export const UI_THEMES = {
  dark: {
    background: '#11111b',
    surface: '#1e1e2e',
    border: '#313244',
    text: '#cdd6f4',
    textMuted: '#a6adc8',
    accent: '#89b4fa',
    danger: '#f38ba8',
    success: '#a6e3a1',
    warning: '#fab387',
    terminal: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
    },
  },
  light: {
    background: '#eff1f5',
    surface: '#ffffff',
    border: '#ccd0da',
    text: '#4c4f69',
    textMuted: '#6c6f85',
    accent: '#1e66f5',
    danger: '#d20f39',
    success: '#40a02b',
    warning: '#fe640b',
    terminal: {
      background: '#ffffff',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
    },
  },
  mocha: {
    background: '#11111b',
    surface: '#1e1e2e',
    border: '#313244',
    text: '#cdd6f4',
    textMuted: '#a6adc8',
    accent: '#cba6f7',
    danger: '#f38ba8',
    success: '#a6e3a1',
    warning: '#fab387',
    terminal: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
    },
  },
  macchiato: {
    background: '#181926',
    surface: '#1e2030',
    border: '#363a4f',
    text: '#cad3f5',
    textMuted: '#a5adcb',
    accent: '#c6a0f6',
    danger: '#ed8796',
    success: '#a6da95',
    warning: '#f5a97f',
    terminal: {
      background: '#1e2030',
      foreground: '#cad3f5',
      cursor: '#f4dbd6',
    },
  },
  frappe: {
    background: '#232634',
    surface: '#292c3c',
    border: '#414559',
    text: '#c6d0f5',
    textMuted: '#a5adce',
    accent: '#ca9ee6',
    danger: '#e78284',
    success: '#a6d189',
    warning: '#ef9f76',
    terminal: {
      background: '#292c3c',
      foreground: '#c6d0f5',
      cursor: '#f2d5cf',
    },
  },
  latte: {
    background: '#eff1f5',
    surface: '#e6e9ef',
    border: '#ccd0da',
    text: '#4c4f69',
    textMuted: '#6c6f85',
    accent: '#8839ef',
    danger: '#d20f39',
    success: '#40a02b',
    warning: '#fe640b',
    terminal: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
    },
  },
} as const;

function isThemePreference(value: string | null): value is ThemePreference {
  return value !== null && value in UI_THEMES;
}

function isTerminalFont(value: string | null): value is TerminalFont {
  return value !== null && (TERMINAL_FONTS as string[]).includes(value);
}

export function loadPreferences(): AppPreferences {
  const theme = localStorage.getItem(THEME_KEY);
  const terminalFont = localStorage.getItem(FONT_KEY);
  return {
    theme: isThemePreference(theme) ? theme : 'dark',
    terminalFont: isTerminalFont(terminalFont) ? terminalFont : 'JetBrains Mono',
  };
}

export function savePreferences(prefs: AppPreferences): void {
  localStorage.setItem(THEME_KEY, prefs.theme);
  localStorage.setItem(FONT_KEY, prefs.terminalFont);
}
