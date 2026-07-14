import type { Theme } from './terminal';

export const THEMES: Record<string, Theme> = {
  default: {
    base16: [
      '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
      '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
    ],
    fg: '#cbd5e1',
    bg: '#05070e',
  },
  dracula: {
    base16: [
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff',
    ],
    fg: '#f8f8f2',
    bg: '#282a36',
  },
  'solarized-dark': {
    base16: [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
    ],
    fg: '#839496',
    bg: '#002b36',
  },
};

export const THEME_IDS = Object.keys(THEMES) as (keyof typeof THEMES)[];
