import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { registerTetherLinks } from '../src/terminalRendererLinks';
import type { RendererCommand, RendererEvent } from '../src/terminalRendererProtocol';
import { touchScrollLines } from '../src/terminalTouchScroll';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(data: string): void };
    __tetherDispatch(command: RendererCommand): void;
  }
}

type RendererEventBody = RendererEvent extends infer Event
  ? Event extends { v: 1 }
    ? Omit<Event, 'v'>
    : never
  : never;

const post = (event: RendererEventBody) =>
  window.ReactNativeWebView?.postMessage(JSON.stringify({ v: 1, ...event }));

const terminal = new Terminal({
  allowProposedApi: true,
  convertEol: false,
  cursorBlink: true,
  scrollback: 1000,
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById('terminal')!);

let lastTouchY: number | null = null;
let touchRemainder = 0;
terminal.element!.addEventListener(
  'touchstart',
  (event) => {
    if (event.touches.length !== 1) {
      lastTouchY = null;
      return;
    }
    lastTouchY = event.touches[0].clientY;
    touchRemainder = 0;
  },
  { passive: true },
);
terminal.element!.addEventListener(
  'touchmove',
  (event) => {
    if (lastTouchY === null || event.touches.length !== 1) return;
    const currentY = event.touches[0].clientY;
    const screenHeight =
      terminal.element!.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect()
        .height ?? 0;
    const result = touchScrollLines(
      lastTouchY - currentY,
      touchRemainder,
      screenHeight / terminal.rows,
    );
    lastTouchY = currentY;
    touchRemainder = result.remainder;
    if (result.lines) terminal.scrollLines(result.lines);
    event.preventDefault();
  },
  { passive: false },
);
terminal.element!.addEventListener('touchend', () => {
  lastTouchY = null;
  touchRemainder = 0;
});

registerTetherLinks(terminal, (target) => post({ type: 'openLink', target }));
terminal.onData((text) => post({ type: 'input', text }));
terminal.onSelectionChange(() => post({ type: 'selection', text: terminal.getSelection() }));

let lastCols = 0;
let lastRows = 0;
const fitAndReport = () => {
  try {
    fit.fit();
  } catch {
    return;
  }
  if (terminal.cols === lastCols && terminal.rows === lastRows) return;
  lastCols = terminal.cols;
  lastRows = terminal.rows;
  terminal.refresh(0, terminal.rows - 1);
  post({ type: 'resize', cols: lastCols, rows: lastRows });
};

new ResizeObserver(fitAndReport).observe(document.getElementById('terminal')!);

window.__tetherDispatch = (command) => {
  if (!command || command.v !== 1) return;
  switch (command.type) {
    case 'hydrate':
      terminal.reset();
      terminal.options.theme = command.theme;
      document.documentElement.style.colorScheme = command.theme.keyboardAppearance;
      terminal.options.fontFamily = command.fontFamily;
      terminal.options.fontSize = command.fontSize;
      terminal.resize(command.cols, command.rows);
      terminal.write(command.data, fitAndReport);
      break;
    case 'write':
      terminal.write(command.data);
      break;
    case 'resize':
      if (command.cols !== terminal.cols || command.rows !== terminal.rows) {
        terminal.resize(command.cols, command.rows);
      }
      break;
    case 'scroll':
      terminal.scrollToLine(command.line);
      break;
    case 'selectAll':
      terminal.selectAll();
      break;
    case 'focus':
      terminal.focus();
      break;
    case 'blur':
      terminal.blur();
      break;
  }
};

fitAndReport();
post({ type: 'ready' });
