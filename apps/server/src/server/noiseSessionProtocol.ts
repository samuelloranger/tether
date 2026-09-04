import { logError } from './log';
import type { FrameIO, ServerChannel } from './noiseChannel';
import {
  type FocusSubscriber,
  resizeSession,
  startSession,
  subscribeToSession,
  writeToSession,
} from './pty';

/**
 * The subset of `pty.ts` the Noise session loop drives. Injected so the loop is
 * testable without a real PTY/holder; defaults to the live functions.
 */
export interface SessionDeps {
  startSession: typeof startSession;
  subscribeToSession: typeof subscribeToSession;
  writeToSession: typeof writeToSession;
  resizeSession: typeof resizeSession;
}

const defaultDeps: SessionDeps = {
  startSession,
  subscribeToSession,
  writeToSession,
  resizeSession,
};

/** Client -> server application messages, after Noise decryption + JSON parse. */
type ClientMessage =
  | { t: 'start'; id: string; command?: string; cols?: number; rows?: number }
  | { t: 'input'; id: string; text: string }
  | { t: 'resize'; id: string; cols: number; rows: number };

interface Attachment {
  unsub: () => void;
  sub: FocusSubscriber;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The application protocol that runs OVER an already-established `ServerChannel`
 * (the Noise handshake + authorization happened before this is called). It is a
 * sealed mirror of the password-authed `/api/ws` terminal protocol: `start`
 * spawns/attaches a session and streams its output back sealed, `input` writes
 * keystrokes, `resize` refits the PTY.
 *
 * Every server->client frame is `channel.seal(JSON.stringify(...))`; every
 * client->server frame is `JSON.parse(channel.open(wire))`. The loop ends — and
 * unsubscribes — on a decrypt/parse error or when `io.recv()` rejects (socket
 * closed). It never throws to the caller.
 */
export async function runNoiseSession(
  channel: ServerChannel,
  io: FrameIO,
  deps: Partial<SessionDeps> = {},
): Promise<void> {
  const d: SessionDeps = { ...defaultDeps, ...deps };
  // One attachment per session id opened on this channel.
  const attachments = new Map<string, Attachment>();

  const cleanup = () => {
    for (const a of attachments.values()) {
      try {
        a.unsub();
      } catch {}
    }
    attachments.clear();
  };

  const sendSealed = (obj: unknown): void => {
    try {
      io.send(channel.seal(encoder.encode(JSON.stringify(obj))));
    } catch (err) {
      logError('Noise session: failed to seal/send frame:', err);
    }
  };

  const makeSubscriber = (id: string): FocusSubscriber => {
    const onData: FocusSubscriber = (data) => {
      if (data.type === 'output') {
        sendSealed({ t: 'output', chunk: data.chunk, id: data.id });
      } else if (data.type === 'exit') {
        sendSealed({ t: 'exit', id, exitCode: data.exitCode });
      }
    };
    // A remote Noise client is the sole viewer of its own session; treat it as
    // focused so activity/notification gating matches the terminal WS path.
    onData.focused = true;
    return onData;
  };

  try {
    for (;;) {
      const wire = await io.recv();
      let msg: ClientMessage;
      try {
        msg = JSON.parse(decoder.decode(channel.open(wire))) as ClientMessage;
      } catch (err) {
        // A frame we can't decrypt or parse means the stream is unusable.
        logError('Noise session: decrypt/parse failed, ending session:', err);
        return;
      }

      if (msg.t === 'start') {
        const cols = msg.cols ?? 80;
        const rows = msg.rows ?? 24;
        try {
          await d.startSession(msg.id, msg.command, cols, rows);
        } catch (err) {
          logError(`Noise session: startSession('${msg.id}') failed:`, err);
          continue;
        }
        // Replace any prior subscription for this id (a re-`start`).
        attachments.get(msg.id)?.unsub();
        const sub = makeSubscriber(msg.id);
        const unsub = d.subscribeToSession(msg.id, sub, cols, rows);
        attachments.set(msg.id, { unsub, sub });
      } else if (msg.t === 'input') {
        d.writeToSession(msg.id, msg.text);
      } else if (msg.t === 'resize') {
        // resizeSession keys the PTY-fit off the exact subscriber object, so only
        // resize a session this channel actually subscribed to.
        const attachment = attachments.get(msg.id);
        if (attachment) d.resizeSession(msg.id, attachment.sub, msg.cols, msg.rows);
      }
    }
  } catch {
    // io.recv() rejected (socket closed) — fall through to cleanup.
  } finally {
    cleanup();
  }
}
