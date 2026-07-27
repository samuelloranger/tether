import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { registerTetherLinks } from './terminalRendererLinks';
import { TERMINAL_RENDERER_CSS } from './terminalRenderer.generated';
import { RendererQueue, type RendererCommand } from './terminalRendererProtocol';
import type { TerminalViewHandle, TerminalViewProps } from './TerminalView.types';

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  ({ onInput, onResize, onOpenLink, onSelection, onFallback, onStatus }, ref) => {
    const container = useRef<HTMLDivElement>(null);
    const callbacks = useRef({ onInput, onResize, onOpenLink, onSelection, onFallback, onStatus });
    callbacks.current = { onInput, onResize, onOpenLink, onSelection, onFallback, onStatus };
    const dispatch = useRef<(command: RendererCommand) => void>(() => {});
    const queue = useMemo(() => new RendererQueue((command) => dispatch.current(command)), []);

    useImperativeHandle(
      ref,
      () => ({
        hydrate: (...args) => queue.hydrate(...args),
        write: (data) => queue.write(data),
        resize: (cols, rows) => queue.resize(cols, rows),
        scrollToLine: (line) => queue.scrollToLine(line),
        selectAll: () => queue.selectAll(),
        focus: () => queue.focus(),
        blur: () => queue.blur(),
        // Desktop renders xterm straight into the DOM: there is no separate page
        // to lose, so there is nothing to recover from and nothing to retry.
        retry: () => {},
      }),
      [queue],
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
      const links = registerTetherLinks(terminal, (target) => callbacks.current.onOpenLink(target));
      const input = terminal.onData((data) => callbacks.current.onInput(data));
      const selection = terminal.onSelectionChange(() =>
        callbacks.current.onSelection?.(terminal.getSelection()),
      );
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
          case 'blur':
            terminal.blur();
            break;
          case 'dispose':
            terminal.dispose();
            break;
        }
      };
      queue.ready();
      fitAndReport();

      return () => {
        queue.notReady();
        observer.disconnect();
        input.dispose();
        selection.dispose();
        links.dispose();
        webgl?.dispose();
        terminal.dispose();
      };
    }, [queue]);

    return (
      <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
        <style>{TERMINAL_RENDERER_CSS}</style>
        <div ref={container} style={{ width: '100%', height: '100%' }} />
      </div>
    );
  },
);
