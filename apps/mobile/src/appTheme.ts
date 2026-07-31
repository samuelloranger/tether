import type { Theme as TerminalTheme } from './terminal';

export const THEME_STORAGE_KEY = 'tether_theme';
export const SYSTEM_DARK_THEME_STORAGE_KEY = 'tether_system_dark_theme';
export const THEME_OPTIONS = [
  'system',
  'default-dark',
  'default-light',
  'latte',
  'frappe',
  'macchiato',
  'mocha',
] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number];
export type ResolvedFlavor = Exclude<ThemePreference, 'system'>;
export type DarkFlavor = Exclude<ResolvedFlavor, 'latte' | 'default-light'>;
export type CatppuccinFlavor = 'latte' | 'frappe' | 'macchiato' | 'mocha';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';
export const DEFAULT_SYSTEM_DARK_FLAVOR: DarkFlavor = 'default-dark';

export function parseThemePreference(value: string | null): ThemePreference {
  return THEME_OPTIONS.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : DEFAULT_THEME_PREFERENCE;
}

export function parseDarkFlavor(value: string | null): DarkFlavor {
  return value === 'default-dark' ||
    value === 'frappe' ||
    value === 'macchiato' ||
    value === 'mocha'
    ? value
    : DEFAULT_SYSTEM_DARK_FLAVOR;
}

/** System follows the OS into Default light / Default dark. Explicit picks win. */
export function resolveFlavor(
  preference: ThemePreference,
  scheme: 'light' | 'dark' | 'unspecified' | null | undefined,
  _systemDarkFlavor: DarkFlavor = DEFAULT_SYSTEM_DARK_FLAVOR,
): ResolvedFlavor {
  if (preference !== 'system') return preference;
  return scheme === 'light' ? 'default-light' : 'default-dark';
}

export function selectThemePreference(
  _preference: ThemePreference,
  systemDarkFlavor: DarkFlavor,
  next: ThemePreference,
) {
  return {
    preference: next,
    systemDarkFlavor:
      next === 'default-dark' || next === 'frappe' || next === 'macchiato' || next === 'mocha'
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

const CATPPUCCIN = {
  latte: {
    crust: '#dce0e8',
    mantle: '#e6e9ef',
    base: '#eff1f5',
    surface0: '#ccd0da',
    surface1: '#bcc0cc',
    text: '#4c4f69',
    subtext0: '#6c6f85',
    overlay0: '#9ca0b0',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    mauve: '#8839ef',
    pink: '#ea76cb',
    teal: '#179299',
    sky: '#04a5e5',
  },
  frappe: {
    crust: '#232634',
    mantle: '#292c3c',
    base: '#303446',
    surface0: '#414559',
    surface1: '#51576d',
    text: '#c6d0f5',
    subtext0: '#a5adce',
    overlay0: '#737994',
    red: '#e78284',
    green: '#a6d189',
    yellow: '#e5c890',
    blue: '#8caaee',
    mauve: '#ca9ee6',
    pink: '#f4b8e4',
    teal: '#81c8be',
    sky: '#99d1db',
  },
  macchiato: {
    crust: '#181926',
    mantle: '#1e2030',
    base: '#24273a',
    surface0: '#363a4f',
    surface1: '#494d64',
    text: '#cad3f5',
    subtext0: '#a5adcb',
    overlay0: '#6e738d',
    red: '#ed8796',
    green: '#a6da95',
    yellow: '#eed49f',
    blue: '#8aadf4',
    mauve: '#c6a0f6',
    pink: '#f5bde6',
    teal: '#8bd5ca',
    sky: '#91d7e3',
  },
  mocha: {
    crust: '#11111b',
    mantle: '#181825',
    base: '#1e1e2e',
    surface0: '#313244',
    surface1: '#45475a',
    text: '#cdd6f4',
    subtext0: '#a6adc8',
    overlay0: '#6c7086',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    mauve: '#cba6f7',
    pink: '#f5c2e7',
    teal: '#94e2d5',
    sky: '#89dceb',
  },
} as const;

function terminalFromCatppuccin(p: (typeof CATPPUCCIN)[CatppuccinFlavor]): TerminalTheme {
  return {
    base16: [
      p.crust,
      p.red,
      p.green,
      p.yellow,
      p.blue,
      p.mauve,
      p.teal,
      p.text,
      p.surface1,
      p.red,
      p.green,
      p.yellow,
      p.blue,
      p.pink,
      p.sky,
      p.text,
    ],
    fg: p.text,
    bg: p.base,
  };
}

function createCatppuccinTheme(flavor: CatppuccinFlavor): AppTheme {
  const p = CATPPUCCIN[flavor];
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
      overlay: `${p.crust}99`,
      selected: p.surface1,
      accent: p.mauve,
      accentText: p.base,
      success: p.green,
      warning: p.yellow,
      danger: p.red,
      info: p.blue,
    },
    terminal: terminalFromCatppuccin(p),
    keyboardAppearance: flavor === 'latte' ? 'light' : 'dark',
  };
}

/** Instrument bezel chrome; terminal well stays Catppuccin Mocha / Latte. */
function createDefaultTheme(flavor: 'default-dark' | 'default-light'): AppTheme {
  if (flavor === 'default-dark') {
    return {
      flavor,
      colors: {
        background: '#0b0c0f',
        surface: '#12141a',
        surfaceRaised: '#1a1d24',
        input: '#08090c',
        text: '#e8eaef',
        textMuted: '#9aa0ad',
        textFaint: '#6b7280',
        border: '#2a2e38',
        overlay: '#08090c99',
        selected: '#1a1d24',
        accent: '#3ddc97',
        accentText: '#0b0c0f',
        success: '#3ddc97',
        warning: '#e6b84d',
        danger: '#ff5c6a',
        info: '#4d8dff',
      },
      terminal: terminalFromCatppuccin(CATPPUCCIN.mocha),
      keyboardAppearance: 'dark',
    };
  }
  return {
    flavor,
    colors: {
      background: '#f4f5f7',
      surface: '#ffffff',
      surfaceRaised: '#eceef2',
      input: '#ffffff',
      text: '#0a0a0b',
      textMuted: '#5c5c66',
      textFaint: '#8b8b96',
      border: '#d5d7de',
      overlay: '#0a0a0b66',
      selected: '#eceef2',
      accent: '#0b7a4b',
      accentText: '#ffffff',
      success: '#0b7a4b',
      warning: '#9a6b00',
      danger: '#c41e3a',
      info: '#002fa7',
    },
    terminal: terminalFromCatppuccin(CATPPUCCIN.latte),
    keyboardAppearance: 'light',
  };
}

export const APP_THEMES: Record<ResolvedFlavor, AppTheme> = {
  'default-dark': createDefaultTheme('default-dark'),
  'default-light': createDefaultTheme('default-light'),
  latte: createCatppuccinTheme('latte'),
  frappe: createCatppuccinTheme('frappe'),
  macchiato: createCatppuccinTheme('macchiato'),
  mocha: createCatppuccinTheme('mocha'),
};
