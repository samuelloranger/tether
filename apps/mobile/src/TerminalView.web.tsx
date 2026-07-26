import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { registerTetherLinks } from './terminalRendererLinks';
import { TERMINAL_RENDERER_CSS } from './terminalRenderer.generated';
import { RendererQueue, type RendererCommand } from './terminalRendererProtocol';
import type { TerminalViewHandle, TerminalViewProps } from './TerminalView.types';

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  ({ onInput, onResize, onOpenLink, onFallback }, ref) => {
    const container = useRef<HTMLDivElement>(null);
    const dispatch = useRef<(command: RendererCommand) => void>(() => {});
    const queue = useMemo(() => new RendererQueue((command) => dispatch.current(command)), []);

    useImperativeHandle(
      ref,
      () => ({
        hydrate: (...args) => queue.hydrate(...args),
        write: (data) => queue.write(data),
        resize: (cols, rows) => queue.resize(cols, rows),
        focus: () => queue.focus(),
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
          onFallback('webgl-context-lost');
          terminal.refresh(0, terminal.rows - 1);
        });
        terminal.loadAddon(webgl);
      } catch (error) {
        webgl = null;
        onFallback(String(error));
      }

      const links = registerTetherLinks(terminal, onOpenLink);
      const input = terminal.onData(onInput);
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
        onResize(lastCols, lastRows);
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
          case 'focus':
            terminal.focus();
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
        links.dispose();
        webgl?.dispose();
        terminal.dispose();
      };
    }, [onFallback, onInput, onOpenLink, onResize, queue]);

    return (
      <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
        <style>{TERMINAL_RENDERER_CSS}</style>
        <div ref={container} style={{ width: '100%', height: '100%' }} />
      </div>
    );
  },
);
