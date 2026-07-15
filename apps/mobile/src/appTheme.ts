import type { Theme as TerminalTheme } from './terminal';

export const THEME_STORAGE_KEY = 'tether_theme';
export const SYSTEM_DARK_THEME_STORAGE_KEY = 'tether_system_dark_theme';
export const THEME_OPTIONS = ['system', 'latte', 'frappe', 'macchiato', 'mocha'] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number];
export type ResolvedFlavor = Exclude<ThemePreference, 'system'>;
export type DarkFlavor = Exclude<ResolvedFlavor, 'latte'>;

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';
export const DEFAULT_SYSTEM_DARK_FLAVOR: DarkFlavor = 'mocha';

export function parseThemePreference(value: string | null): ThemePreference {
  return THEME_OPTIONS.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : DEFAULT_THEME_PREFERENCE;
}

export function parseDarkFlavor(value: string | null): DarkFlavor {
  return value === 'frappe' || value === 'macchiato' || value === 'mocha'
    ? value
    : DEFAULT_SYSTEM_DARK_FLAVOR;
}

export function resolveFlavor(
  preference: ThemePreference,
  scheme: 'light' | 'dark' | 'unspecified' | null | undefined,
  systemDarkFlavor: DarkFlavor = DEFAULT_SYSTEM_DARK_FLAVOR,
): ResolvedFlavor {
  return preference === 'system' ? (scheme === 'light' ? 'latte' : systemDarkFlavor) : preference;
}

export function selectThemePreference(
  _preference: ThemePreference,
  systemDarkFlavor: DarkFlavor,
  next: ThemePreference,
) {
  return {
    preference: next,
    systemDarkFlavor: next === 'frappe' || next === 'macchiato' || next === 'mocha'
      ? next
      : systemDarkFlavor,
  };
}

export interface AppColors {
  background: string;
  surface: string;
  surfaceRaised: string;
  input: string;
  text: string;
  textMuted: string;
  textFaint: string;
  border: string;
  overlay: string;
  selected: string;
  accent: string;
  accentText: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

export interface AppTheme {
  flavor: ResolvedFlavor;
  colors: AppColors;
  terminal: TerminalTheme;
  keyboardAppearance: 'light' | 'dark';
}

const PALETTES = {
  latte: { crust: '#dce0e8', mantle: '#e6e9ef', base: '#eff1f5', surface0: '#ccd0da', surface1: '#bcc0cc', text: '#4c4f69', subtext0: '#6c6f85', overlay0: '#9ca0b0', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', mauve: '#8839ef', pink: '#ea76cb', teal: '#179299', sky: '#04a5e5' },
  frappe: { crust: '#232634', mantle: '#292c3c', base: '#303446', surface0: '#414559', surface1: '#51576d', text: '#c6d0f5', subtext0: '#a5adce', overlay0: '#737994', red: '#e78284', green: '#a6d189', yellow: '#e5c890', blue: '#8caaee', mauve: '#ca9ee6', pink: '#f4b8e4', teal: '#81c8be', sky: '#99d1db' },
  macchiato: { crust: '#181926', mantle: '#1e2030', base: '#24273a', surface0: '#363a4f', surface1: '#494d64', text: '#cad3f5', subtext0: '#a5adcb', overlay0: '#6e738d', red: '#ed8796', green: '#a6da95', yellow: '#eed49f', blue: '#8aadf4', mauve: '#c6a0f6', pink: '#f5bde6', teal: '#8bd5ca', sky: '#91d7e3' },
  mocha: { crust: '#11111b', mantle: '#181825', base: '#1e1e2e', surface0: '#313244', surface1: '#45475a', text: '#cdd6f4', subtext0: '#a6adc8', overlay0: '#6c7086', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', mauve: '#cba6f7', pink: '#f5c2e7', teal: '#94e2d5', sky: '#89dceb' },
} as const;

function createTheme(flavor: ResolvedFlavor): AppTheme {
  const p = PALETTES[flavor];
  return {
    flavor,
    colors: {
      background: p.base,
      surface: p.mantle,
      surfaceRaised: p.surface0,
      input: p.crust,
      text: p.text,
      textMuted: p.subtext0,
      textFaint: p.overlay0,
      border: p.surface1,
      overlay: '#0000008c',
      selected: p.surface1,
      accent: p.mauve,
      accentText: p.base,
      success: p.green,
      warning: p.yellow,
      danger: p.red,
      info: p.blue,
    },
    terminal: {
      base16: [p.crust, p.red, p.green, p.yellow, p.blue, p.mauve, p.teal, p.text,
        p.surface1, p.red, p.green, p.yellow, p.blue, p.pink, p.sky, p.text],
      fg: p.text,
      bg: p.base,
    },
    keyboardAppearance: flavor === 'latte' ? 'light' : 'dark',
  };
}

export const APP_THEMES: Record<ResolvedFlavor, AppTheme> = {
  latte: createTheme('latte'),
  frappe: createTheme('frappe'),
  macchiato: createTheme('macchiato'),
  mocha: createTheme('mocha'),
};
