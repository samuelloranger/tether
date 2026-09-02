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

/**
 * Whether a flavour is a light one. The native title bar follows the *window*
 * theme rather than our CSS, so the shell has to tell the window which way to
 * dress — otherwise a light palette renders under a dark title bar.
 */
export function isLightFlavor(flavor: ResolvedFlavor): boolean {
  return flavor === 'latte' || flavor === 'default-light';
}
export type CatppuccinFlavor = 'latte' | 'frappe' | 'macchiato' | 'mocha';

/**
 * Only faces the app actually ships. The list used to offer Fira Code, IBM Plex
 * Mono and Source Code Pro, none of which were bundled — so they resolved to
 * whatever the OS had, and `loadPreferences` did not accept them back anyway,
 * which meant picking one appeared to work and silently reverted on reload.
 */
export type TerminalFont = 'JetBrains Mono Variable' | 'monospace';

const THEME_KEY = 'tether.desktop.theme';
const FONT_KEY = 'tether.desktop.terminalFont';
const SIDEBAR_PIN_KEY = 'tether_sidebar_pinned';
const NOTIFICATIONS_KEY = 'tether_notifications_enabled';
const TAB_LAYOUT_KEY = 'tether_tab_layout';

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

export interface TerminalThemeColors {
  background: string;
  foreground: string;
  cursor: string;
}

/**
 * The three colours a session's state can be wearing.
 *
 * These are not decoration and not a second accent palette: the chrome reads
 * whichever one matches the state of the session you are looking at (see
 * `litTheme.ts`), so switching sessions re-tints the app. Every flavour carries
 * its own triple so a Catppuccin theme stays inside its own palette.
 */
export interface HeatColors {
  /** producing output */
  working: string;
  /** wants an answer from you */
  waiting: string;
  /** finished a piece of work — wears the flavour's success token */
  done: string;
  /** alive and quiet — also the structural/idle tint */
  cool: string;
}

export interface UiTheme {
  flavor: ResolvedFlavor;
  colors: AppColors;
  terminal: TerminalThemeColors;
  heat: HeatColors;
}

export const TAB_LAYOUTS = ['sidebar', 'horizontal'] as const;
export type TabLayout = (typeof TAB_LAYOUTS)[number];

export interface AppPreferences {
  theme: ThemePreference;
  terminalFont: TerminalFont;
  sidebarPinned: boolean;
  notificationsEnabled: boolean;
  tabLayout: TabLayout;
}

export const TERMINAL_FONTS: TerminalFont[] = ['JetBrains Mono Variable', 'monospace'];

export const TERMINAL_FONT_LABELS: Record<TerminalFont, string> = {
  'JetBrains Mono Variable': 'JetBrains Mono',
  monospace: 'System monospace',
};

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  'default-dark': 'Default dark',
  'default-light': 'Default light',
  latte: 'Latte',
  frappe: 'Frappé',
  macchiato: 'Macchiato',
  mocha: 'Mocha',
};

export const TAB_LAYOUT_LABELS: Record<TabLayout, string> = {
  sidebar: 'Sidebar',
  horizontal: 'Horizontal',
};

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

function fromCatppuccin(flavor: CatppuccinFlavor): UiTheme {
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
    terminal: {
      background: p.base,
      foreground: p.text,
      cursor: flavor === 'latte' ? '#dc8a78' : '#f5e0dc',
    },
    heat: { working: p.yellow, waiting: p.red, done: p.green, cool: p.blue },
  };
}

/** Aurora: violet-tinted ink rather than neutral black, and the terminal is a
 *  deeper slab than the chrome so it reads as a lit screen inset in it. */
function defaultDark(): UiTheme {
  return {
    flavor: 'default-dark',
    colors: {
      background: '#08080e',
      surface: '#12121d',
      surfaceRaised: '#191926',
      input: '#0b0b13',
      text: '#edeef6',
      textMuted: '#9797ac',
      textFaint: '#61617a',
      border: '#232333',
      overlay: '#08080ecc',
      selected: '#191926',
      accent: '#7c8cf8',
      accentText: '#08080e',
      success: '#6ee7a8',
      warning: '#f2b34c',
      danger: '#ff7050',
      info: '#7c8cf8',
    },
    terminal: { background: '#0b0b13', foreground: '#ccccdf', cursor: '#f5e0dc' },
    heat: { working: '#f2b34c', waiting: '#ff7050', done: '#6ee7a8', cool: '#7c8cf8' },
  };
}

function defaultLight(): UiTheme {
  return {
    flavor: 'default-light',
    colors: {
      background: '#f1f1f6',
      surface: '#ffffff',
      surfaceRaised: '#e9e9f2',
      input: '#ffffff',
      text: '#14141b',
      textMuted: '#5c5c6c',
      textFaint: '#8a8a9c',
      border: '#dcdce6',
      overlay: '#14141b66',
      selected: '#e9e9f2',
      accent: '#4353d0',
      accentText: '#ffffff',
      success: '#1c7a4f',
      warning: '#8a5a00',
      danger: '#c4381c',
      info: '#4353d0',
    },
    terminal: fromCatppuccin('latte').terminal,
    heat: { working: '#8a5a00', waiting: '#c4381c', done: '#1c7a4f', cool: '#4353d0' },
  };
}

export const UI_THEMES: Record<ResolvedFlavor, UiTheme> = {
  'default-dark': defaultDark(),
  'default-light': defaultLight(),
  latte: fromCatppuccin('latte'),
  frappe: fromCatppuccin('frappe'),
  macchiato: fromCatppuccin('macchiato'),
  mocha: fromCatppuccin('mocha'),
};

/** Back-compat alias for callers that still key dark/light. */
export type LegacyThemePreference = 'dark' | 'light';

export function parseThemePreference(value: string | null): ThemePreference {
  if (value === 'dark') return 'default-dark';
  if (value === 'light') return 'default-light';
  return THEME_OPTIONS.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
}

export function parseTabLayout(value: string | null): TabLayout {
  return TAB_LAYOUTS.includes(value as TabLayout) ? (value as TabLayout) : 'sidebar';
}

export function resolveFlavor(
  preference: ThemePreference,
  scheme: 'light' | 'dark' | null | undefined,
): ResolvedFlavor {
  if (preference !== 'system') return preference;
  return scheme === 'light' ? 'default-light' : 'default-dark';
}

export function loadPreferences(): AppPreferences {
  const theme = parseThemePreference(localStorage.getItem(THEME_KEY));
  const terminalFont = localStorage.getItem(FONT_KEY);
  const pinned = localStorage.getItem(SIDEBAR_PIN_KEY);
  const notifications = localStorage.getItem(NOTIFICATIONS_KEY);
  return {
    theme,
    terminalFont: TERMINAL_FONTS.includes(terminalFont as TerminalFont)
      ? (terminalFont as TerminalFont)
      : 'JetBrains Mono Variable',
    sidebarPinned: pinned === 'true',
    notificationsEnabled: notifications !== 'false',
    tabLayout: parseTabLayout(localStorage.getItem(TAB_LAYOUT_KEY)),
  };
}

export function savePreferences(prefs: AppPreferences): void {
  localStorage.setItem(THEME_KEY, prefs.theme);
  localStorage.setItem(FONT_KEY, prefs.terminalFont);
  localStorage.setItem(SIDEBAR_PIN_KEY, prefs.sidebarPinned ? 'true' : 'false');
  localStorage.setItem(NOTIFICATIONS_KEY, prefs.notificationsEnabled ? 'true' : 'false');
  localStorage.setItem(TAB_LAYOUT_KEY, prefs.tabLayout);
}

export function sidebarLayout(opts: {
  wide: boolean;
  sidebarPinned: boolean;
  drawerOpen: boolean;
  tabLayout?: TabLayout;
}): { docked: boolean; visible: boolean; showMenuButton: boolean; showTabBar: boolean } {
  if (opts.tabLayout === 'horizontal') {
    return { docked: false, visible: false, showMenuButton: false, showTabBar: true };
  }
  const docked = opts.wide && opts.sidebarPinned;
  return {
    docked,
    visible: docked || opts.drawerOpen,
    showMenuButton: opts.wide && !opts.sidebarPinned,
    showTabBar: false,
  };
}
