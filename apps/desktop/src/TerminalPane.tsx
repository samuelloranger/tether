import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import {
  forgetCoreSession,
  nextConnId,
  openCoreSocket,
  sendJson,
  type TerminalSocket,
} from './coreTransport';
import { applyServerFrame, createFrameSink, type FrameApplyResult } from './frameHandler';
import type { UI_THEMES } from './preferences';
import { createReplayGate } from './replayGate';

import '@xterm/xterm/css/xterm.css';

export interface TerminalPaneProps {
  wsOrigin: string;
  password: string;
  sessionId: string;
  hostId: string;
  terminalTheme: (typeof UI_THEMES)[keyof typeof UI_THEMES]['terminal'];
  fontFamily: string;
  fontSize?: number;
  onFrame: (hostId: string, sessionId: string, frame: FrameApplyResult) => void;
  onDisconnected: () => void;
}

function mountTerminal(
  container: HTMLElement,
  terminalTheme: TerminalPaneProps['terminalTheme'],
  fontFamily: string,
  fontSize: number,
): {
  term: Terminal;
  fit: FitAddon;
  dispose: () => void;
} {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: `${fontFamily}, ui-monospace, monospace`,
    fontSize,
    theme: terminalTheme,
    allowProposedApi: true,
    scrollback: 1000,
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one effect owns connect, replay gate, and resize
export function TerminalPane(props: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onFrameRef = useRef(props.onFrame);
  const onDisconnectedRef = useRef(props.onDisconnected);
  onFrameRef.current = props.onFrame;
  onDisconnectedRef.current = props.onDisconnected;

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return undefined;

    // Tied to this xterm instance — must not survive effect re-runs or session
    // switches. Log ids are global on the server, so a stale cursor drops another
    // session's replay as "already applied".
    let lastAppliedId = 0;

    const { term, fit, dispose } = mountTerminal(
      container,
      props.terminalTheme,
      props.fontFamily,
      props.fontSize ?? 14,
    );
    // writeDepth > 0 means xterm is parsing SERVER output right now, so
    // anything it emits on onData in that window is a parser auto-reply
    // rather than the user typing.
    let writeDepth = 0;
    const sink = createFrameSink(term, {
      beginWrite: () => {
        writeDepth += 1;
      },
      endWrite: () => {
        writeDepth = Math.max(0, writeDepth - 1);
      },
    });
    const replay = createReplayGate();
    let socket: TerminalSocket | null = null;
    let closed = false;

    replay.onConnect();

    const onClose = () => {
      if (closed) return;
      closed = true;
      onDisconnectedRef.current();
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
          const result = applyServerFrame(sink, raw, lastAppliedId);
          lastAppliedId = result.lastAppliedId;
          if (result.kind === 'output') replay.onOutput();
          if (result.kind === 'reset') replay.onReset();
          onFrameRef.current(props.hostId, props.sessionId, result);
        },
        onClose,
      },
    ).then((s) => {
      if (closed) {
        s.close();
        return;
      }
      socket = s;
    });

    term.onData((text) => {
      // Suppress ONLY auto-replies to queries embedded in replayed scrollback.
      // User keystrokes always go through: gating them on output activity made
      // the terminal silently swallow typing during any busy output.
      const isAutoReply = writeDepth > 0;
      if (isAutoReply && replay.isReplaying()) return;
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
      replay.dispose();
      observer.disconnect();
      socket?.close();
      dispose();
      void forgetCoreSession(props.sessionId);
    };
  }, [
    props.sessionId,
    props.hostId,
    props.wsOrigin,
    props.password,
    props.terminalTheme,
    props.fontFamily,
    props.fontSize,
  ]);

  return <div className="terminal-host" ref={hostRef} />;
}
