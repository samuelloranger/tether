import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { nextConnId, openCoreSocket, sendJson, type TerminalSocket } from './coreTransport';
import { applyServerFrame, createFrameSink } from './frameHandler';

import '@xterm/xterm/css/xterm.css';

const TERM_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
};

export interface TerminalPaneProps {
  wsOrigin: string;
  password: string;
  sessionId: string;
  onDisconnected: () => void;
}

function mountTerminal(container: HTMLElement): {
  term: Terminal;
  fit: FitAddon;
  dispose: () => void;
} {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'JetBrains Mono, Fira Code, monospace',
    fontSize: 14,
    theme: TERM_THEME,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();
  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // Software renderer fallback.
  }
  return { term, fit, dispose: () => term.dispose() };
}

function readDims(fit: FitAddon): { cols: number; rows: number } {
  const dims = fit.proposeDimensions();
  return { cols: dims?.cols ?? 80, rows: dims?.rows ?? 24 };
}

export function TerminalPane(props: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef(0);

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return undefined;

    const { term, fit, dispose } = mountTerminal(container);
    const sink = createFrameSink(term);
    let socket: TerminalSocket | null = null;
    let closed = false;

    const onClose = () => {
      if (closed) return;
      closed = true;
      props.onDisconnected();
    };

    fit.fit();
    const { cols, rows } = readDims(fit);
    void openCoreSocket(
      nextConnId(),
      props.wsOrigin,
      props.password,
      { sessionId: props.sessionId, cols, rows },
      {
        onOpen: () => {},
        onMessage: (raw) => {
          lastIdRef.current = applyServerFrame(sink, raw, lastIdRef.current);
        },
        onClose,
      },
    ).then((s) => {
      socket = s;
    });

    term.onData((text) => {
      if (socket) sendJson(socket, { type: 'input', text });
    });

    const observer = new ResizeObserver(() => {
      fit.fit();
      if (!socket) return;
      const next = readDims(fit);
      sendJson(socket, { type: 'resize', cols: next.cols, rows: next.rows });
    });
    observer.observe(container);

    return () => {
      closed = true;
      observer.disconnect();
      socket?.close();
      dispose();
    };
  }, [props.sessionId, props.wsOrigin, props.password, props.onDisconnected]);

  return <div className="terminal-host" ref={hostRef} />;
}
