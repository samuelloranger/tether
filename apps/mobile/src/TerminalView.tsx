import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { writeClipboard } from './clipboard';
import {
  COPY,
  FONT_LARGER,
  FONT_SMALLER,
  keyToBytes,
  NEW_TERMINAL,
  PASTE,
  SELECT_ALL,
} from './desktopKeys';
import { bindPageTerminal, type PageHostEmit } from './pageTerminalHost';
import { isMacDesktop } from './platform';
import type { TerminalViewHandle, TerminalViewProps } from './TerminalView.types';
import { TERMINAL_RENDERER_CSS } from './terminalRenderer.generated';
import { registerTetherLinks } from './terminalRendererLinks';
import { type RendererCommand, RendererQueue, RendererRpc } from './terminalRendererProtocol';

const CONTROL_TYPES = new Set(['title', 'cwd', 'bell', 'notify', 'promptReturn', 'modes']);

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  (
    {
      onInput,
      onResize,
      onOpenLink,
      onSelection,
      onControl,
      onReply,
      onClipboardWrite,
      onPaste,
      onNewTerminal,
      onFontZoom,
      onFallback,
      onStatus,
    },
    ref,
  ) => {
    const container = useRef<HTMLDivElement>(null);
    const callbacks = useRef({
      onInput,
      onResize,
      onOpenLink,
      onSelection,
      onControl,
      onReply,
      onClipboardWrite,
      onPaste,
      onNewTerminal,
      onFontZoom,
      onFallback,
      onStatus,
    });
    callbacks.current = {
      onInput,
      onResize,
      onOpenLink,
      onSelection,
      onControl,
      onReply,
      onClipboardWrite,
      onPaste,
      onNewTerminal,
      onFontZoom,
      onFallback,
      onStatus,
    };
    const dispatch = useRef<(command: RendererCommand) => void>(() => {});
    const hydrateWait = useRef<(() => void) | null>(null);
    const queue = useMemo(() => new RendererQueue((command) => dispatch.current(command)), []);
    const rpc = useMemo(() => new RendererRpc((command) => dispatch.current(command)), []);

    useImperativeHandle(
      ref,
      () => ({
        hydrate: (...args) =>
          new Promise<void>((resolve) => {
            hydrateWait.current = resolve;
            queue.hydrate(...args);
          }),
        write: (data) => queue.write(data),
        resize: (cols, rows) => queue.resize(cols, rows),
        scrollToLine: (line) => queue.scrollToLine(line),
        selectAll: () => queue.selectAll(),
        focus: () => queue.focus(),
        blur: () => queue.blur(),
        // Desktop renders xterm straight into the DOM: there is no separate page
        // to lose, so there is nothing to recover from and nothing to retry.
        retry: () => {},
        serialize: () => rpc.requestSerialize(),
        snapshotText: () => rpc.requestSnapshotText(),
        jumpPrompt: (dir) => queue.jumpPrompt(dir),
      }),
      [queue, rpc],
    );

    useEffect(() => {
      if (!container.current) return;
      const terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        scrollback: 1000,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(container.current);

      const themeColors = { foreground: '#cccccc', background: '#1e1e2e' };
      const onEmit = (event: PageHostEmit) => {
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
          callbacks.current.onReply?.(event.data);
          return;
        }
        if (event.type === 'clipboardWrite') {
          callbacks.current.onClipboardWrite?.(event.text);
          return;
        }
        if (CONTROL_TYPES.has(event.type)) {
          callbacks.current.onControl?.(event);
        }
      };
      const page = bindPageTerminal(terminal, onEmit, themeColors);

      let webgl: WebglAddon | null = null;
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl?.dispose();
          webgl = null;
          callbacks.current.onFallback('webgl-context-lost');
          terminal.refresh(0, terminal.rows - 1);
        });
        terminal.loadAddon(webgl);
      } catch (error) {
        webgl = null;
        callbacks.current.onFallback(String(error));
      }

      // Same DOM, same JS context — it is ready the moment it is constructed.
      callbacks.current.onStatus?.('ready');
      const links = registerTetherLinks(
        terminal,
        (target) => callbacks.current.onOpenLink(target),
        { requireModifierClick: true },
      );
      const input = terminal.onData((data) => callbacks.current.onInput(data));
      const selection = terminal.onSelectionChange(() =>
        callbacks.current.onSelection?.(terminal.getSelection()),
      );
      // xterm's hidden textarea owns focus while the terminal is active, so the
      // window-level desktop key handler intentionally skips it. App shortcuts
      // (clipboard, select-all, new terminal, font zoom) must live here.
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const action = keyToBytes(event, false, isMacDesktop, !!terminal.getSelection());
        if (action === COPY) {
          const text = terminal.getSelection();
          if (text) void writeClipboard(text);
          return false;
        }
        if (action === PASTE) {
          void callbacks.current.onPaste?.();
          return false;
        }
        if (action === SELECT_ALL) {
          terminal.selectAll();
          return false;
        }
        if (action === NEW_TERMINAL) {
          callbacks.current.onNewTerminal?.();
          return false;
        }
        if (action === FONT_LARGER) {
          callbacks.current.onFontZoom?.(1);
          return false;
        }
        if (action === FONT_SMALLER) {
          callbacks.current.onFontZoom?.(-1);
          return false;
        }
        return true;
      });
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
      const observer = new ResizeObserver(fitAndReport);
      observer.observe(container.current);

      dispatch.current = (command) => {
        if (page.handleRpc(command)) return;
        switch (command.type) {
          case 'hydrate':
            page.resetPrompts();
            terminal.reset();
            themeColors.foreground = command.theme.foreground;
            themeColors.background = command.theme.background;
            terminal.options.theme = command.theme;
            terminal.options.fontFamily = command.fontFamily;
            terminal.options.fontSize = command.fontSize;
            terminal.resize(command.cols, command.rows);
            terminal.write(command.data, () => {
              page.restorePromptLines(command.promptLines ?? []);
              page.afterWrite();
              fitAndReport();
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
      };
      queue.ready();
      fitAndReport();

      return () => {
        rpc.clear('disposed');
        queue.notReady();
        observer.disconnect();
        input.dispose();
        selection.dispose();
        links.dispose();
        page.dispose();
        webgl?.dispose();
        terminal.dispose();
      };
    }, [queue, rpc]);

    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          boxSizing: 'border-box',
          paddingLeft: 4,
          paddingRight: 4,
        }}
      >
        <style>{TERMINAL_RENDERER_CSS}</style>
        <div ref={container} style={{ width: '100%', height: '100%' }} />
      </div>
    );
  },
);
