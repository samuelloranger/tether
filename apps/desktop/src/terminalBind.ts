import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import {
  forgetCoreSession,
  nextConnId,
  openCoreSocket,
  sendJson,
  type TerminalSocket,
} from './coreTransport';
import { applyServerFrame, createFrameSink, type FrameApplyResult } from './frameHandler';
import { shouldSendOutbound } from './ptyOutbound';
import { createReplayGate, type ReplayGate } from './replayGate';
import { copyTerminalSelection, isCopyChord, writeSystemClipboard } from './terminalClipboard';
import { registerTetherLinks } from './terminalLinks';
import { attachTerminalMouse } from './terminalMouse';
import { observeMouseSgr, registerOsc52Handler } from './terminalOsc';
import { isFindChord } from './terminalSearch';

export interface BoundTerminalSession {
  socket: () => TerminalSocket | null;
  dispose: () => void;
}

function attachFeatures(
  term: Terminal,
  sendInput: (text: string, isAutoReply: boolean) => void,
  isInteractive: () => boolean,
  onOpenFind: () => void,
): () => void {
  let mouseSgr = false;
  const osc52 = registerOsc52Handler(term, (text) => {
    if (!isInteractive()) return;
    void writeSystemClipboard(text).catch(() => {});
  });
  const unMouseSgr = observeMouseSgr(term, (enabled) => {
    mouseSgr = enabled;
  });
  const links = registerTetherLinks(term);
  const unMouse = attachTerminalMouse(term, {
    send: (bytes) => sendInput(bytes, false),
    isInteractive,
    mouseSgr: () => mouseSgr,
  });
  const onKey = (event: KeyboardEvent) => {
    if (!isInteractive()) return;
    if (isCopyChord(event)) {
      event.preventDefault();
      void copyTerminalSelection(term).catch(() => {});
      return;
    }
    if (isFindChord(event)) {
      event.preventDefault();
      onOpenFind();
    }
  };
  term.attachCustomKeyEventHandler((event) => !(isCopyChord(event) || isFindChord(event)));
  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('keydown', onKey);
    unMouse();
    links.dispose();
    unMouseSgr();
    osc52.dispose();
  };
}

function openSocket(
  input: {
    fit: FitAddon;
    hostId: string;
    sessionId: string;
    wsOrigin: string;
    password: string;
    onFrame: (hostId: string, sessionId: string, frame: FrameApplyResult) => void;
    onDisconnected: () => void;
  },
  sink: ReturnType<typeof createFrameSink>,
  replay: ReplayGate,
  state: { lastAppliedId: number; socket: TerminalSocket | null; closed: boolean },
): void {
  const onClose = () => {
    if (state.closed) return;
    state.closed = true;
    input.onDisconnected();
  };
  input.fit.fit();
  const dims = input.fit.proposeDimensions();
  void openCoreSocket(
    nextConnId(),
    input.wsOrigin,
    input.password,
    { sessionId: input.sessionId, cols: dims?.cols ?? 80, rows: dims?.rows ?? 24 },
    {
      onOpen: () => {},
      onMessage: (raw) => {
        const result = applyServerFrame(sink, raw, state.lastAppliedId);
        state.lastAppliedId = result.lastAppliedId;
        if (result.kind === 'output') replay.onOutput();
        if (result.kind === 'reset') replay.onReset();
        input.onFrame(input.hostId, input.sessionId, result);
      },
      onClose,
    },
  ).then((s) => {
    if (state.closed) {
      s.close();
      return;
    }
    state.socket = s;
  });
}

export function bindTerminalSession(input: {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  hostId: string;
  sessionId: string;
  wsOrigin: string;
  password: string;
  isInteractive: () => boolean;
  onFrame: (hostId: string, sessionId: string, frame: FrameApplyResult) => void;
  onDisconnected: () => void;
  onOpenFind: () => void;
}): BoundTerminalSession {
  const state = { lastAppliedId: 0, socket: null as TerminalSocket | null, closed: false };
  let writeDepth = 0;
  const sink = createFrameSink(input.term, {
    beginWrite: () => {
      writeDepth += 1;
    },
    endWrite: () => {
      writeDepth = Math.max(0, writeDepth - 1);
    },
  });
  const replay = createReplayGate();
  replay.onConnect();

  const sendInput = (text: string, isAutoReply: boolean) => {
    if (!shouldSendOutbound(isAutoReply, replay.isReplaying())) return;
    if (!isAutoReply && !input.isInteractive()) return;
    if (state.socket) sendJson(state.socket, { type: 'input', text });
  };

  openSocket(input, sink, replay, state);
  const dataSub = input.term.onData((text) => sendInput(text, writeDepth > 0));
  const unFeatures = attachFeatures(input.term, sendInput, input.isInteractive, input.onOpenFind);

  const observer = new ResizeObserver(() => {
    input.fit.fit();
    if (!state.socket) return;
    const next = input.fit.proposeDimensions();
    sendJson(state.socket, { type: 'resize', cols: next?.cols ?? 80, rows: next?.rows ?? 24 });
  });
  if (input.term.element?.parentElement) observer.observe(input.term.element.parentElement);

  return {
    socket: () => state.socket,
    dispose: () => {
      state.closed = true;
      replay.dispose();
      observer.disconnect();
      dataSub.dispose();
      unFeatures();
      state.socket?.close();
      void forgetCoreSession(input.sessionId);
    },
  };
}
