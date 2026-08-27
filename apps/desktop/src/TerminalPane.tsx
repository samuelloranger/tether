import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { sendJson, type TerminalSocket } from './coreTransport';
import type { FrameApplyResult } from './frameHandler';
import { setPasteListener } from './pasteBus';
import { pastePayload } from './pastePayload';
import type { UI_THEMES } from './preferences';
import { bindTerminalSession } from './terminalBind';
import { TerminalFindBar } from './terminalSearch';

import '@xterm/xterm/css/xterm.css';

/** Local xterm history — independent of server `scrollbackRows` (log retention). */
const LOCAL_SCROLLBACK = 5000;

export interface TerminalPaneProps {
  wsOrigin: string;
  password: string;
  sessionId: string;
  hostId: string;
  interactive: boolean;
  terminalTheme: (typeof UI_THEMES)[keyof typeof UI_THEMES]['terminal'];
  fontFamily: string;
  fontSize?: number;
  onFrame: (hostId: string, sessionId: string, frame: FrameApplyResult) => void;
  onDisconnected: () => void;
}

function mountTerminal(
  container: HTMLElement,
  boot: TerminalPaneProps['terminalTheme'],
  fontFamily: string,
  fontSize: number,
): {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  dispose: () => void;
} {
  const term = new Terminal({
    cursorBlink: true,
    // Mount with the real theme and face. Booting from a fixed Catppuccin
    // Mocha constant flashed the wrong background for a frame on every other
    // flavour — visibly so on the light ones.
    fontFamily: `${fontFamily}, ui-monospace, monospace`,
    fontSize,
    theme: boot,
    allowProposedApi: true,
    scrollback: LOCAL_SCROLLBACK,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.open(container);
  fit.fit();
  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // Software renderer fallback.
  }
  return { term, fit, search, dispose: () => term.dispose() };
}

type BootOpts = {
  theme: TerminalPaneProps['terminalTheme'];
  fontFamily: string;
  fontSize: number;
};

function bindMountedTerminal(input: {
  container: HTMLElement;
  boot: BootOpts;
  hostId: string;
  sessionId: string;
  wsOrigin: string;
  password: string;
  isInteractive: () => boolean;
  onFrame: TerminalPaneProps['onFrame'];
  onDisconnected: () => void;
  onOpenFind: () => void;
}): {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  socket: () => TerminalSocket | null;
  sendFocus: (focused: boolean) => void;
  dispose: () => void;
} {
  const mounted = mountTerminal(
    input.container,
    input.boot.theme,
    input.boot.fontFamily,
    input.boot.fontSize,
  );
  const bound = bindTerminalSession({
    term: mounted.term,
    fit: mounted.fit,
    search: mounted.search,
    hostId: input.hostId,
    sessionId: input.sessionId,
    wsOrigin: input.wsOrigin,
    password: input.password,
    isInteractive: input.isInteractive,
    onFrame: input.onFrame,
    onDisconnected: input.onDisconnected,
    onOpenFind: input.onOpenFind,
  });
  return {
    term: mounted.term,
    fit: mounted.fit,
    search: mounted.search,
    socket: bound.socket,
    sendFocus: bound.sendFocus,
    dispose: () => {
      bound.dispose();
      mounted.dispose();
    },
  };
}

function useTerminalMount(props: TerminalPaneProps, interactiveRef: { current: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const getSocketRef = useRef<(() => TerminalSocket | null) | null>(null);
  const sendFocusRef = useRef<((focused: boolean) => void) | null>(null);
  const onFrameRef = useRef(props.onFrame);
  const onDisconnectedRef = useRef(props.onDisconnected);
  onFrameRef.current = props.onFrame;
  onDisconnectedRef.current = props.onDisconnected;
  // Boot-only values. Theme/font changes must not remount (would drop scrollback).
  const bootRef = useRef<BootOpts>({
    theme: props.terminalTheme,
    fontFamily: props.fontFamily,
    fontSize: props.fontSize ?? 14,
  });
  bootRef.current = {
    theme: props.terminalTheme,
    fontFamily: props.fontFamily,
    fontSize: props.fontSize ?? 14,
  };
  const [search, setSearch] = useState<SearchAddon | null>(null);
  const [findOpen, setFindOpen] = useState(false);

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return undefined;
    const live = bindMountedTerminal({
      container,
      boot: bootRef.current,
      hostId: props.hostId,
      sessionId: props.sessionId,
      wsOrigin: props.wsOrigin,
      password: props.password,
      isInteractive: () => interactiveRef.current,
      onFrame: (hostId, sessionId, frame) => onFrameRef.current(hostId, sessionId, frame),
      onDisconnected: () => onDisconnectedRef.current(),
      onOpenFind: () => setFindOpen(true),
    });
    termRef.current = live.term;
    fitRef.current = live.fit;
    setSearch(live.search);
    getSocketRef.current = live.socket;
    sendFocusRef.current = live.sendFocus;
    return () => {
      live.dispose();
      getSocketRef.current = null;
      sendFocusRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      setSearch(null);
    };
  }, [props.sessionId, props.hostId, props.wsOrigin, props.password, interactiveRef]);

  return { hostRef, termRef, fitRef, getSocketRef, sendFocusRef, search, findOpen, setFindOpen };
}

export function TerminalPane(props: TerminalPaneProps) {
  const interactiveRef = useRef(props.interactive);
  interactiveRef.current = props.interactive;
  const { hostRef, termRef, fitRef, getSocketRef, sendFocusRef, search, findOpen, setFindOpen } =
    useTerminalMount(props, interactiveRef);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = props.terminalTheme;
    term.options.fontFamily = `${props.fontFamily}, ui-monospace, monospace`;
    term.options.fontSize = props.fontSize ?? 14;
    fitRef.current?.fit();
  }, [props.terminalTheme, props.fontFamily, props.fontSize, termRef, fitRef]);

  // Sprint D's paste bridge, gated to the active tab: every resident session
  // keeps a live socket, but only the focused one may receive a paste.
  useEffect(() => {
    if (!props.interactive) return undefined;
    setPasteListener((text) => {
      const socket = getSocketRef.current?.() ?? null;
      const term = termRef.current;
      if (!socket || !term) return;
      const payload = pastePayload(text, term.modes.bracketedPasteMode);
      sendJson(socket, { type: 'input', text: payload });
    });
    return () => setPasteListener(null);
  }, [props.interactive, getSocketRef, termRef]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const socket = getSocketRef.current?.() ?? null;
    if (!term || !fit) return;
    if (props.interactive) {
      term.focus();
      fit.fit();
      const next = fit.proposeDimensions();
      if (socket)
        sendJson(socket, { type: 'resize', cols: next?.cols ?? 80, rows: next?.rows ?? 24 });
      sendFocusRef.current?.(true);
    } else {
      term.blur();
      setFindOpen(false);
      sendFocusRef.current?.(false);
    }
  }, [props.interactive, termRef, fitRef, getSocketRef, sendFocusRef, setFindOpen]);

  // Window / document blur while this pane is active — same push-suppression
  // contract as iOS scenePhase (server suppresses while focused:true).
  useEffect(() => {
    if (!props.interactive) return undefined;
    const report = () => {
      const visible = document.visibilityState === 'visible' && document.hasFocus();
      sendFocusRef.current?.(visible);
    };
    window.addEventListener('blur', report);
    window.addEventListener('focus', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      window.removeEventListener('blur', report);
      window.removeEventListener('focus', report);
      document.removeEventListener('visibilitychange', report);
    };
  }, [props.interactive, sendFocusRef]);

  return (
    <div className={`resident-pane${props.interactive ? ' active' : ' inactive'}`}>
      {props.interactive && findOpen ? (
        <TerminalFindBar search={search} onClose={() => setFindOpen(false)} />
      ) : null}
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
