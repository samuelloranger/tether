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

/**
 * The Noise sibling of `openCoreSocket`. Streams a session over the sealed Noise
 * channel via `core_noise_connect`, which emits the SAME `core-message-{connId}`
 * / `core-closed-{connId}` events in WS-JSON, so the handlers are identical to
 * the password path. Input/resize go out as WS-JSON through `coreNoiseSend`
 * (the Rust command translates them to the Noise session protocol); close ends
 * the channel. `address` is the `ws://host:port/api/noise/session` endpoint.
 */
export async function openNoiseSocket(
  connId: string,
  hostId: string,
  address: string,
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
    await invoke('core_noise_connect', {
      connId,
      hostId,
      address,
      sessionId: params.sessionId,
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
    });
    h.onOpen();
  } catch {
    cleanup();
    h.onClose();
  }
  return {
    send: (text) => {
      invoke('core_noise_send', { connId, text }).catch(() => {
        cleanup();
        h.onClose();
      });
    },
    close: () => {
      cleanup();
      invoke('core_noise_close', { connId }).catch(() => {});
    },
  };
}

export function sendJson(socket: TerminalSocket, payload: unknown): void {
  socket.send(JSON.stringify(payload));
}

/** Drop the core replay cursor when the visible emulator is torn down. */
export async function forgetCoreSession(sessionId: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('core_forget', { sessionId }).catch(() => {});
}
