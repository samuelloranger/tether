export const TERMINAL_SCROLLBAR_CSS = `
#tether-terminal,
#tether-terminal * {
  scrollbar-width: thin;
  scrollbar-color: var(--tether-scrollbar-thumb) var(--tether-scrollbar-track);
}
#tether-terminal::-webkit-scrollbar,
#tether-terminal *::-webkit-scrollbar { width: 10px; height: 10px; }
#tether-terminal::-webkit-scrollbar-track,
#tether-terminal *::-webkit-scrollbar-track { background: var(--tether-scrollbar-track); }
#tether-terminal::-webkit-scrollbar-thumb,
#tether-terminal *::-webkit-scrollbar-thumb {
  background: var(--tether-scrollbar-thumb);
  border: 2px solid var(--tether-scrollbar-track);
  border-radius: 999px;
}
#tether-terminal::-webkit-scrollbar-thumb:hover,
#tether-terminal *::-webkit-scrollbar-thumb:hover { background: var(--tether-scrollbar-thumb-hover); }
`;

const STYLE_ID = 'tether-terminal-scrollbar-styles';

export function injectTerminalScrollbarStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TERMINAL_SCROLLBAR_CSS;
  document.head.appendChild(style);
}
