// Terminal WebSocket transport, abstracted over platform so App.tsx doesn't care
// how the socket is opened:
//   - Native (iOS/Android): RN WebSocket with the Authorization header (3-arg form).
//   - Tauri desktop: the Rust WS bridge — invoke ws_connect/ws_send/ws_close and
//     receive frames via the ws-message / ws-closed events (browsers can't set the
//     Authorization header, so the socket lives in Rust).
//   - Plain web (no Tauri): unsupported (documented) — the header can't be sent.

export interface TerminalSocket {
  send(text: string): void;
  close(): void;
}

export interface TransportHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: () => void;
}

// Tauri injects __TAURI_INTERNALS__ into the webview global.
export function isTauri(): boolean {
  return typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}

function openRnSocket(
  url: string,
  headers: Record<string, string>,
  h: TransportHandlers,
): TerminalSocket {
  const Ctor = WebSocket as unknown as {
    new (u: string, p: string[], o: { headers: Record<string, string> }): WebSocket;
  };
  const sock = new Ctor(url, [], { headers });
  sock.onopen = () => h.onOpen();
  sock.onmessage = (e: MessageEvent) => h.onMessage(e.data as string);
  sock.onclose = () => h.onClose();
  sock.onerror = () => {};
  return {
    send: (t) => {
      if (sock.readyState === WebSocket.OPEN) sock.send(t);
    },
    close: () => sock.close(),
  };
}

async function openTauriSocket(
  url: string,
  password: string,
  h: TransportHandlers,
): Promise<TerminalSocket> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const unlistenMsg = await listen<string>('ws-message', (e) => h.onMessage(e.payload));
  const unlistenClose = await listen('ws-closed', () => h.onClose());
  const cleanup = () => {
    unlistenMsg();
    unlistenClose();
  };
  try {
    await invoke('ws_connect', { url, password });
    h.onOpen();
  } catch {
    cleanup();
    h.onClose();
  }
  return {
    send: (t) => {
      void invoke('ws_send', { text: t });
    },
    close: () => {
      cleanup();
      void invoke('ws_close');
    },
  };
}

// Open a terminal socket for the current platform. `password` is used directly by
// the Tauri bridge and turned into an Authorization header for the RN path.
export function openTerminalSocket(
  url: string,
  password: string,
  h: TransportHandlers,
): TerminalSocket {
  if (isTauri()) {
    // Bridge is async to set up; buffer a proxy until it resolves.
    let real: TerminalSocket | null = null;
    let closed = false;
    const pending: string[] = [];
    openTauriSocket(url, password, h).then((s) => {
      if (closed) {
        s.close();
        return;
      }
      real = s;
      for (const t of pending) s.send(t);
      pending.length = 0;
    });
    return {
      send: (t) => {
        if (real) real.send(t);
        else pending.push(t);
      },
      close: () => {
        closed = true;
        real?.close();
      },
    };
  }
  return openRnSocket(url, { Authorization: `Bearer ${password}` }, h);
}
