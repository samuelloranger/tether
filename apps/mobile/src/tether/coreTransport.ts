import type { TerminalSocket, TransportHandlers } from '../wsTransport';

// The tether-core transport (P0 spike). Unlike `openTauriSocket`, this does not
// pass sinceId: the Rust core retains the replay cursor per session, so a
// reconnect resumes correctly without the TS side tracking it. Frames arrive
// verbatim on `core-message-<connId>`, so callers parse exactly what they parse
// on the old path.
//
// Opt-in per machine:  localStorage.setItem('tether.coreTransport', '1')

type StorageLike = { getItem(key: string): string | null } | undefined;

export const CORE_TRANSPORT_FLAG = 'tether.coreTransport';

export function coreTransportEnabled(storage?: StorageLike): boolean {
  const store = storage ?? (globalThis as { localStorage?: StorageLike }).localStorage;
  if (!store) return false;
  try {
    return store.getItem(CORE_TRANSPORT_FLAG) === '1';
  } catch {
    return false;
  }
}

export interface CoreConnectParams {
  sessionId: string;
  sinceId?: number;
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

/** Builds the `core_connect` payload. `sinceId` is dropped on purpose. */
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
