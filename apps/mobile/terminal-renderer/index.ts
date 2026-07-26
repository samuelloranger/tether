import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { registerTetherLinks } from '../src/terminalRendererLinks';
import type { RendererCommand, RendererEvent } from '../src/terminalRendererProtocol';

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
    case 'dispose':
      terminal.dispose();
      break;
  }
};

fitAndReport();
post({ type: 'ready' });
