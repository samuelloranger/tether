import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { sendJson, type TerminalSocket } from './coreTransport';
import type { FrameApplyResult } from './frameHandler';
import { setPasteListener } from './pasteBus';
import type { UI_THEMES } from './preferences';
import { bindTerminalSession } from './terminalBind';
import { TerminalFindBar } from './terminalSearch';

import '@xterm/xterm/css/xterm.css';

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
    fontSize: 14,
    theme: boot,
    allowProposedApi: true,
    scrollback: 1000,
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

function useTerminalMount(props: TerminalPaneProps, interactiveRef: { current: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const getSocketRef = useRef<(() => TerminalSocket | null) | null>(null);
  const onFrameRef = useRef(props.onFrame);
  const onDisconnectedRef = useRef(props.onDisconnected);
  onFrameRef.current = props.onFrame;
  onDisconnectedRef.current = props.onDisconnected;
  // Boot-only values. They must not sit in the mount effect's dependencies:
  // remounting the terminal on a theme or font change would throw away the
  // scrollback. A later effect applies changes to the live instance.
  const bootRef = useRef({ theme: props.terminalTheme, fontFamily: props.fontFamily });
  bootRef.current = { theme: props.terminalTheme, fontFamily: props.fontFamily };
  const [search, setSearch] = useState<SearchAddon | null>(null);
  const [findOpen, setFindOpen] = useState(false);

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return undefined;
    const {
      term,
      fit,
      search: searchAddon,
      dispose,
    } = mountTerminal(container, bootRef.current.theme, bootRef.current.fontFamily);
    termRef.current = term;
    fitRef.current = fit;
    setSearch(searchAddon);
    const bound = bindTerminalSession({
      term,
      fit,
      search: searchAddon,
      hostId: props.hostId,
      sessionId: props.sessionId,
      wsOrigin: props.wsOrigin,
      password: props.password,
      isInteractive: () => interactiveRef.current,
      onFrame: (hostId, sessionId, frame) => onFrameRef.current(hostId, sessionId, frame),
      onDisconnected: () => onDisconnectedRef.current(),
      onOpenFind: () => setFindOpen(true),
    });
    getSocketRef.current = bound.socket;
    return () => {
      bound.dispose();
      getSocketRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      setSearch(null);
      dispose();
    };
  }, [props.sessionId, props.hostId, props.wsOrigin, props.password, interactiveRef]);

  return { hostRef, termRef, fitRef, getSocketRef, search, findOpen, setFindOpen };
}

export function TerminalPane(props: TerminalPaneProps) {
  const interactiveRef = useRef(props.interactive);
  interactiveRef.current = props.interactive;
  const { hostRef, termRef, fitRef, getSocketRef, search, findOpen, setFindOpen } =
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
      if (socket) sendJson(socket, { type: 'input', text });
    });
    return () => setPasteListener(null);
  }, [props.interactive, getSocketRef]);

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
    } else {
      term.blur();
      setFindOpen(false);
    }
  }, [props.interactive, termRef, fitRef, getSocketRef, setFindOpen]);

  return (
    <div className={`resident-pane${props.interactive ? ' active' : ' inactive'}`}>
      {props.interactive && findOpen ? (
        <TerminalFindBar search={search} onClose={() => setFindOpen(false)} />
      ) : null}
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
