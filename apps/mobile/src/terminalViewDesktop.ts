import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { writeClipboard } from './clipboard';
import {
  COPY,
  FONT_LARGER,
  FONT_SMALLER,
  isTerminalNavKey,
  keyNeedsFallback,
  keyToBytes,
  NEW_TERMINAL,
  PASTE,
  resolveKeyboardKey,
  SELECT_ALL,
} from './desktopKeys';
import type { LinkTarget } from './links';
import { bindPageTerminal, type PageHostEmit } from './pageTerminalHost';
import { isMacDesktop } from './platform';
import type { RendererStatus } from './rendererLifecycle';
import { FitCoalescer } from './terminalFitCoalescer';
import { registerTetherLinks } from './terminalRendererLinks';
import type { RendererCommand, RendererQueue, RendererRpc } from './terminalRendererProtocol';
import { attachWebgl } from './terminalWebgl';
import type { PageControlEvent } from './tether/pageControlState';

const CONTROL_TYPES = new Set(['title', 'cwd', 'bell', 'notify', 'promptReturn', 'modes']);

export type DesktopTerminalCallbacks = {
  onInput: (text: string) => void;
  onResize: (cols: number, rows: number) => void;
  onOpenLink: (target: LinkTarget) => void;
  onSelection?: (text: string) => void;
  onControl?: (event: PageControlEvent) => void;
  onReply?: (data: string) => void;
  onClipboardWrite?: (text: string) => void;
  onPaste?: () => void | Promise<void>;
  onNewTerminal?: () => void;
  onFontZoom?: (delta: number) => void;
  onFallback: (reason: string) => void;
  onStatus?: (status: RendererStatus) => void;
};

function applyXtermGutter(xtermEl: HTMLElement | null | undefined) {
  if (!xtermEl) return;
  xtermEl.style.boxSizing = 'border-box';
  xtermEl.style.paddingLeft = '4px';
  xtermEl.style.paddingRight = '4px';
}

function handlePageEmit(
  event: PageHostEmit,
  rpc: RendererRpc,
  hydrateWait: { current: (() => void) | null },
  callbacks: DesktopTerminalCallbacks,
) {
  if (event.type === 'serialized') {
    rpc.settle(event.requestId, { data: event.data, promptLines: event.promptLines });
    return;
  }
  if (event.type === 'snapshotText') {
    rpc.settle(event.requestId, event.text);
    return;
  }
  if (event.type === 'hydrated') {
    hydrateWait.current?.();
    hydrateWait.current = null;
    return;
  }
  if (event.type === 'reply') {
    callbacks.onReply?.(event.data);
    return;
  }
  if (event.type === 'clipboardWrite') {
    callbacks.onClipboardWrite?.(event.text);
    return;
  }
  if (CONTROL_TYPES.has(event.type)) {
    callbacks.onControl?.(event);
  }
}

function handleDesktopKey(
  event: KeyboardEvent,
  terminal: Terminal,
  callbacks: DesktopTerminalCallbacks,
): boolean {
  if (event.type !== 'keydown') return true;
  const appCursor = terminal.modes.applicationCursorKeysMode;
  const action = keyToBytes(event, appCursor, isMacDesktop, !!terminal.getSelection());
  if (action === COPY) {
    const text = terminal.getSelection();
    if (text) void writeClipboard(text);
    return false;
  }
  if (action === PASTE) {
    void callbacks.onPaste?.();
    return false;
  }
  if (action === SELECT_ALL) {
    terminal.selectAll();
    return false;
  }
  if (action === NEW_TERMINAL) {
    callbacks.onNewTerminal?.();
    return false;
  }
  if (action === FONT_LARGER) {
    callbacks.onFontZoom?.(1);
    return false;
  }
  if (action === FONT_SMALLER) {
    callbacks.onFontZoom?.(-1);
    return false;
  }
  if (action != null && keyNeedsFallback(event) && isTerminalNavKey(resolveKeyboardKey(event))) {
    callbacks.onInput(action);
    return false;
  }
  return true;
}

function applyDesktopCommand(
  command: RendererCommand,
  terminal: Terminal,
  page: ReturnType<typeof bindPageTerminal>,
  themeColors: { foreground: string; background: string },
  container: HTMLDivElement,
  fitSoon: FitCoalescer,
  onEmit: (event: PageHostEmit) => void,
) {
  if (page.handleRpc(command)) return;
  switch (command.type) {
    case 'hydrate':
      page.resetPrompts();
      terminal.reset();
      themeColors.foreground = command.theme.foreground;
      themeColors.background = command.theme.background;
      terminal.options.theme = command.theme;
      container.style.backgroundColor = command.theme.background;
      terminal.options.fontFamily = command.fontFamily;
      terminal.options.fontSize = command.fontSize;
      terminal.resize(command.cols, command.rows);
      terminal.write(command.data, () => {
        page.restorePromptLines(command.promptLines ?? []);
        page.afterWrite();
        fitSoon.flush();
        onEmit({ type: 'hydrated' });
      });
      break;
    case 'write':
      terminal.write(command.data, () => page.afterWrite());
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
}

function bindDesktopFit(
  terminal: Terminal,
  fit: FitAddon,
  container: HTMLDivElement,
  callbacks: { current: DesktopTerminalCallbacks },
) {
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
    callbacks.current.onResize(lastCols, lastRows);
  };
  const fitSoon = new FitCoalescer(fitAndReport);
  const observer = new ResizeObserver(() => fitSoon.request());
  observer.observe(container);
  return { fitSoon, observer };
}

type MountDesktopOpts = {
  container: HTMLDivElement;
  rpc: RendererRpc;
  queue: RendererQueue;
  callbacks: { current: DesktopTerminalCallbacks };
  hydrateWait: { current: (() => void) | null };
  dispatch: { current: (command: RendererCommand) => void };
};

export function mountDesktopTerminal(opts: MountDesktopOpts): () => void {
  const terminal = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    scrollback: 1000,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(opts.container);
  applyXtermGutter(terminal.element);
  const themeColors = { foreground: '#cccccc', background: '#1e1e2e' };
  const onEmit = (event: PageHostEmit) =>
    handlePageEmit(event, opts.rpc, opts.hydrateWait, opts.callbacks.current);
  const page = bindPageTerminal(terminal, onEmit, themeColors);
  const webgl = attachWebgl(terminal, opts.callbacks);
  opts.callbacks.current.onStatus?.('ready');
  const links = registerTetherLinks(
    terminal,
    (target) => opts.callbacks.current.onOpenLink(target),
    { requireModifierClick: true },
  );
  const input = terminal.onData((data) => opts.callbacks.current.onInput(data));
  const selection = terminal.onSelectionChange(() =>
    opts.callbacks.current.onSelection?.(terminal.getSelection()),
  );
  terminal.attachCustomKeyEventHandler((event) =>
    handleDesktopKey(event, terminal, opts.callbacks.current),
  );
  const { fitSoon, observer } = bindDesktopFit(terminal, fit, opts.container, opts.callbacks);
  opts.dispatch.current = (command) =>
    applyDesktopCommand(command, terminal, page, themeColors, opts.container, fitSoon, onEmit);
  opts.queue.ready();
  fitSoon.flush();
  return () => {
    opts.rpc.clear('disposed');
    opts.queue.notReady();
    observer.disconnect();
    fitSoon.dispose();
    input.dispose();
    selection.dispose();
    links.dispose();
    page.dispose();
    webgl.dispose();
    terminal.dispose();
  };
}
