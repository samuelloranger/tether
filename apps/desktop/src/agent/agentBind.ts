import type { CoreConnectParams, TerminalSocket, TransportHandlers } from '../coreTransport';
import { openNoiseSocket, sendJson } from '../coreTransport';
import type { AgentChatModel } from './agentChatModel';
import { agentStart, decodeAgentFrame } from './agentFrames';

export type AgentOpener = (
  connId: string,
  hostId: string,
  address: string,
  params: CoreConnectParams,
  handlers: TransportHandlers,
) => Promise<TerminalSocket>;

export interface AgentBinding {
  send(payload: unknown): void;
  close(): void;
}

let bindSeq = 0;

/**
 * Wire a Noise socket to one AgentChatModel. Server frames route through the
 * reducer; on each (re)connect the binder sends `agent.start{sinceSeq}` with the
 * reducer's current cursor. Framework-agnostic so it is testable without React —
 * pass a stub `open` in tests.
 */
export function bindAgentSession(input: {
  model: AgentChatModel;
  hostId: string;
  sessionId: string;
  noiseAddress: string;
  cwd?: string;
  open?: AgentOpener;
}): AgentBinding {
  const open = input.open ?? openNoiseSocket;
  bindSeq += 1;
  const connId = `agent-${bindSeq}`;
  let socket: TerminalSocket | null = null;
  let readyPending = false;
  let closed = false;

  // `onReady` (the core "connected" event) and the resolved socket race — either
  // can arrive first. Send agent.start only once both are in hand, or the first
  // start is dropped on a fresh connect.
  const trySendStart = () => {
    if (!socket || !readyPending) return;
    readyPending = false;
    sendJson(
      socket,
      agentStart({ id: input.sessionId, cwd: input.cwd ?? '', sinceSeq: input.model.lastSeq }),
    );
  };

  const handlers: TransportHandlers = {
    onOpen: () => {},
    onMessage: (raw) => {
      const frame = decodeAgentFrame(raw);
      if (frame) input.model.apply(frame);
    },
    onClose: () => {
      socket = null;
    },
    onReady: () => {
      readyPending = true;
      trySendStart();
    },
  };

  const params: CoreConnectParams = { sessionId: input.sessionId, kind: 'agent' };
  void open(connId, input.hostId, input.noiseAddress, params, handlers).then((s) => {
    if (closed) {
      s.close();
      return;
    }
    socket = s;
    trySendStart();
  });

  return {
    send: (payload) => {
      if (socket) sendJson(socket, payload);
    },
    close: () => {
      closed = true;
      socket?.close();
      socket = null;
    },
  };
}
