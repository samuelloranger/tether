import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import {
  forgetCoreSession,
  nextConnId,
  openNoiseSocket,
  sendJson,
  type TerminalSocket,
} from './coreTransport';
import { applyServerFrame, createFrameSink, type FrameApplyResult } from './frameHandler';
import { shouldSendOutbound } from './ptyOutbound';
import { createReplayGate, type ReplayGate } from './replayGate';
import { focusReportBytes, socketOpenFrames } from './resizeFrame';
import { copyTerminalSelection, isCopyChord, writeSystemClipboard } from './terminalClipboard';
import { registerTetherLinks } from './terminalLinks';
import { attachTerminalMouse } from './terminalMouse';
import { observeMouseSgr, registerOsc52Handler } from './terminalOsc';
import { isFindChord } from './terminalSearch';

export interface BoundTerminalSession {
  socket: () => TerminalSocket | null;
  /** Report focus to the server (deduped). Used by TerminalPane for tab/window changes. */
  sendFocus: (focused: boolean) => void;
  dispose: () => void;
}

function sendFocusFrame(
  socket: TerminalSocket | null,
  focused: boolean,
  last: { value: boolean | null },
  term?: Terminal,
): void {
  if (!socket) return;
  if (last.value === focused) return;
  last.value = focused;
  sendJson(socket, { type: 'focus', focused });
  if (term?.modes.sendFocusMode) {
    sendJson(socket, { type: 'input', text: focusReportBytes(focused) });
  }
}

function attachFeatures(
  term: Terminal,
  sendInput: (text: string, isAutoReply: boolean) => void,
  isInteractive: () => boolean,
  onOpenFind: () => void,
): { dispose: () => void; clearMouseSgr: () => void } {
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
  return {
    clearMouseSgr: () => {
      mouseSgr = false;
    },
    dispose: () => {
      window.removeEventListener('keydown', onKey);
      unMouse();
      links.dispose();
      unMouseSgr();
      osc52.dispose();
    },
  };
}

function openSocket(
  input: {
    term: Terminal;
    fit: FitAddon;
    hostId: string;
    sessionId: string;
    noiseAddress: string;
    isInteractive: () => boolean;
    onFrame: (hostId: string, sessionId: string, frame: FrameApplyResult) => void;
    onDisconnected: () => void;
  },
  sink: ReturnType<typeof createFrameSink>,
  replay: ReplayGate,
  state: { lastAppliedId: number; socket: TerminalSocket | null; closed: boolean },
  lastFocus: { value: boolean | null },
): void {
  const onClose = () => {
    if (state.closed) return;
    state.closed = true;
    input.onDisconnected();
  };
  input.fit.fit();
  const dims = input.fit.proposeDimensions();
  const connId = nextConnId();
  const params = { sessionId: input.sessionId, cols: dims?.cols ?? 80, rows: dims?.rows ?? 24 };
  const handlers = {
    onOpen: () => {},
    onMessage: (raw: string) => {
      const result = applyServerFrame(sink, raw, state.lastAppliedId);
      state.lastAppliedId = result.lastAppliedId;
      if (result.kind === 'output') replay.onOutput();
      if (result.kind === 'reset') replay.onReset();
      input.onFrame(input.hostId, input.sessionId, result);
    },
    onClose,
  };
  const socket = openNoiseSocket(connId, input.hostId, input.noiseAddress, params, handlers);
  void socket.then((s) => {
    if (state.closed) {
      s.close();
      return;
    }
    state.socket = s;
    // Fit often ran while `state.socket` was still null, so those observer
    // resizes were dropped. Re-fit now and send resize+focus so a TUI
    // (cursor-agent) gets SIGWINCH / DECSET 1004 instead of staying at the
    // 80×24 `start` geometry.
    input.fit.fit();
    const [resize, focus] = socketOpenFrames(input.fit.proposeDimensions(), input.isInteractive());
    sendJson(s, resize);
    lastFocus.value = null;
    sendFocusFrame(s, focus.focused, lastFocus, input.term);
  });
}

export function bindTerminalSession(input: {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  hostId: string;
  sessionId: string;
  /** `ws://host:port/api/noise/session` — every host streams over Noise. */
  noiseAddress: string;
  isInteractive: () => boolean;
  onFrame: (hostId: string, sessionId: string, frame: FrameApplyResult) => void;
  onDisconnected: () => void;
  onOpenFind: () => void;
}): BoundTerminalSession {
  const state = { lastAppliedId: 0, socket: null as TerminalSocket | null, closed: false };
  const lastFocus = { value: null as boolean | null };
  let writeDepth = 0;
  let clearMouseSgr = () => {};

  const sink = createFrameSink(input.term, {
    beginWrite: () => {
      writeDepth += 1;
    },
    endWrite: () => {
      writeDepth = Math.max(0, writeDepth - 1);
    },
    onReset: () => {
      // term.reset() clears DECSET 1006; our CSI mirror must follow or SGR
      // reports keep firing after a server reset until the next 1006h.
      clearMouseSgr();
    },
  });
  const replay = createReplayGate();
  replay.onConnect();

  const sendInput = (text: string, isAutoReply: boolean) => {
    if (!shouldSendOutbound(isAutoReply, replay.isReplaying())) return;
    if (!isAutoReply && !input.isInteractive()) return;
    if (state.socket) sendJson(state.socket, { type: 'input', text });
  };

  const features = attachFeatures(input.term, sendInput, input.isInteractive, input.onOpenFind);
  clearMouseSgr = features.clearMouseSgr;

  openSocket(input, sink, replay, state, lastFocus);
  const dataSub = input.term.onData((text) => sendInput(text, writeDepth > 0));

  const observer = new ResizeObserver(() => {
    input.fit.fit();
    if (!state.socket) return;
    const next = input.fit.proposeDimensions();
    sendJson(state.socket, { type: 'resize', cols: next?.cols ?? 80, rows: next?.rows ?? 24 });
  });
  if (input.term.element?.parentElement) observer.observe(input.term.element.parentElement);

  return {
    socket: () => state.socket,
    sendFocus: (focused: boolean) => sendFocusFrame(state.socket, focused, lastFocus, input.term),
    dispose: () => {
      state.closed = true;
      replay.dispose();
      observer.disconnect();
      dataSub.dispose();
      features.dispose();
      state.socket?.close();
      void forgetCoreSession(input.sessionId);
    },
  };
}
