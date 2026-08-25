export interface TerminalSocket {
  send(text: string): void;
  close(): void;
}

export interface TransportHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: () => void;
}

export interface CoreConnectParams {
  sessionId: string;
  cols?: number;
  rows?: number;
}

export interface CoreConnectArgs {
  connId: string;
  baseWsUrl: string;
  password: string;
  sessionId: string;
  cols: number;
  rows: number;
}

let connSeq = 0;

export function nextConnId(): string {
  connSeq += 1;
  return `c${connSeq}`;
}

export function buildCoreConnectArgs(
  connId: string,
  baseWsUrl: string,
  password: string,
  params: CoreConnectParams,
): CoreConnectArgs {
  return {
    connId,
    baseWsUrl,
    password,
    sessionId: params.sessionId,
    cols: params.cols ?? 80,
    rows: params.rows ?? 24,
  };
}

export async function openCoreSocket(
  connId: string,
  baseWsUrl: string,
  password: string,
  params: CoreConnectParams,
  h: TransportHandlers,
): Promise<TerminalSocket> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const unMsg = await listen<string>(`core-message-${connId}`, (e) => h.onMessage(e.payload));
  const unClose = await listen(`core-closed-${connId}`, () => h.onClose());
  const cleanup = () => {
    unMsg();
    unClose();
  };
  try {
    const args = buildCoreConnectArgs(connId, baseWsUrl, password, params);
    await invoke('core_connect', {
      connId: args.connId,
      baseWsUrl: args.baseWsUrl,
      password: args.password,
      sessionId: args.sessionId,
      cols: args.cols,
      rows: args.rows,
    });
    h.onOpen();
  } catch {
    cleanup();
    h.onClose();
  }
  return {
    send: (text) => {
      invoke('core_send', { connId, text }).catch(() => {
        cleanup();
        h.onClose();
      });
    },
    close: () => {
      cleanup();
      invoke('core_close', { connId }).catch(() => {});
    },
  };
}

export function sendJson(socket: TerminalSocket, payload: unknown): void {
  socket.send(JSON.stringify(payload));
}
