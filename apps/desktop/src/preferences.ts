export type ThemePreference = 'dark' | 'light';

export type TerminalFont = 'JetBrains Mono' | 'Fira Code' | 'monospace';

const THEME_KEY = 'tether.desktop.theme';
const FONT_KEY = 'tether.desktop.terminalFont';

export interface AppPreferences {
  theme: ThemePreference;
  terminalFont: TerminalFont;
}

export const TERMINAL_FONTS: TerminalFont[] = ['JetBrains Mono', 'Fira Code', 'monospace'];

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
} as const;

export function loadPreferences(): AppPreferences {
  const theme = localStorage.getItem(THEME_KEY);
  const terminalFont = localStorage.getItem(FONT_KEY);
  return {
    theme: theme === 'light' ? 'light' : 'dark',
    terminalFont:
      terminalFont === 'Fira Code' || terminalFont === 'monospace'
        ? terminalFont
        : 'JetBrains Mono',
  };
}

export function savePreferences(prefs: AppPreferences): void {
  localStorage.setItem(THEME_KEY, prefs.theme);
  localStorage.setItem(FONT_KEY, prefs.terminalFont);
}
