import { Platform } from 'react-native';
import { isTauri } from './platform';

// Terminal WebSocket transport, abstracted over platform so App.tsx doesn't care
// how the socket is opened:
//   - Native (iOS/Android): RN WebSocket with the Authorization header (3-arg form).
//   - Tauri desktop: the Rust WS bridge — invoke ws_connect/ws_send/ws_close and
//     receive frames via the ws-message-<id> / ws-closed-<id> events (browsers
//     can't set the Authorization header, so the socket lives in Rust).
//   - Plain web (no Tauri): unsupported — the header can't be sent, so /api/ws
//     rejects with 401. The desktop app must be used instead.

export interface TerminalSocket {
  send(text: string): void;
  close(): void;
}

export interface TransportHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: () => void;
}


let connSeq = 0;

function openRnSocket(
  url: string,
  headers: Record<string, string>,
  h: TransportHandlers,
): TerminalSocket {
  const Ctor = WebSocket as unknown as {
    new (u: string, p: string[], o: { headers: Record<string, string> }): WebSocket;
  };
  const s = new Ctor(url, [], { headers });
  s.onopen = () => h.onOpen();
  s.onmessage = (e: MessageEvent) => h.onMessage(e.data as string);
  s.onclose = () => h.onClose();
  s.onerror = () => {};
  return {
    send: (t) => {
      if (s.readyState === WebSocket.OPEN) s.send(t);
    },
    close: () => s.close(),
  };
}

async function openTauriSocket(
  connId: string,
  url: string,
  password: string,
  h: TransportHandlers,
): Promise<TerminalSocket> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  // Events are scoped by connId so a superseded connection's late frames/close
  // (a stale Rust reader) can't affect the current socket.
  const unMsg = await listen<string>(`ws-message-${connId}`, (e) => h.onMessage(e.payload));
  const unClose = await listen(`ws-closed-${connId}`, () => h.onClose());
  const cleanup = () => {
    unMsg();
    unClose();
  };
  try {
    await invoke('ws_connect', { connId, url, password });
    h.onOpen();
  } catch {
    cleanup();
    h.onClose();
  }
  return {
    send: (t) => {
      // A send after the Rust side has dropped the socket rejects; treat that as
      // a close so the app can reflect the state and reconnect, instead of
      // silently losing the keystroke.
      invoke('ws_send', { text: t }).catch(() => {
        cleanup();
        h.onClose();
      });
    },
    close: () => {
      cleanup();
      void invoke('ws_close');
    },
  };
}

// Open a terminal socket for the current platform.
export function openTerminalSocket(
  url: string,
  password: string,
  h: TransportHandlers,
): TerminalSocket {
  if (isTauri()) {
    const connId = `c${++connSeq}`;
    let real: TerminalSocket | null = null;
    let closed = false;
    const pending: string[] = [];
    openTauriSocket(connId, url, password, h).then((s) => {
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

  // Plain web has no way to send the Authorization header on a WebSocket — the
  // server would reject /api/ws with 401. Only native RN (header supported) and
  // Tauri (Rust bridge) can connect. Surface it as an immediate close.
  if (Platform.OS === 'web') {
    console.warn('Terminal connection needs the desktop app (browser WebSockets cannot authenticate).');
    setTimeout(() => h.onClose(), 0);
    return { send: () => {}, close: () => {} };
  }

  return openRnSocket(url, { Authorization: `Bearer ${password}` }, h);
}
