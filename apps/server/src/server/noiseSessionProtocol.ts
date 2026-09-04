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

// Keep each sealed `output` frame's plaintext well under the FFI transport
// buffer so a fat PTY chunk never overflows it. An overflow would fail the seal
// AFTER the nonce advanced, desyncing the cipher — so we chunk, and also treat
// any seal/send failure as fatal (below).
const MAX_OUTPUT_CHARS = 16 * 1024;

/** Apply one decoded client message to the PTY. Extracted to keep the loop small. */
async function applyMessage(
  msg: ClientMessage,
  d: SessionDeps,
  attachments: Map<string, Attachment>,
  makeSubscriber: (id: string) => FocusSubscriber,
): Promise<void> {
  if (msg.t === 'start') {
    const cols = msg.cols ?? 80;
    const rows = msg.rows ?? 24;
    try {
      await d.startSession(msg.id, msg.command, cols, rows);
    } catch (err) {
      logError(`Noise session: startSession('${msg.id}') failed:`, err);
      return;
    }
    attachments.get(msg.id)?.unsub(); // replace any prior subscription (a re-start)
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

  // A seal advances the Noise nonce; if the seal or send then fails, the cipher
  // is desynced and NOTHING more may be sent on this channel. So a failure is
  // fatal: it resolves `fatal`, which unblocks the recv loop to tear down.
  let fatalErr: Error | null = null;
  let signalFatal: () => void = () => {};
  const fatal = new Promise<void>((resolve) => {
    signalFatal = resolve;
  });

  const cleanup = () => {
    for (const a of attachments.values()) {
      try {
        a.unsub();
      } catch {}
    }
    attachments.clear();
  };

  // Returns false (and trips fatal) on any seal/send failure — callers must stop.
  const sendSealed = (obj: unknown): boolean => {
    if (fatalErr) return false;
    try {
      io.send(channel.seal(encoder.encode(JSON.stringify(obj))));
      return true;
    } catch (err) {
      fatalErr = err instanceof Error ? err : new Error(String(err));
      logError('Noise session: seal/send failed — tearing down (cipher desync risk):', err);
      signalFatal();
      return false;
    }
  };

  const makeSubscriber = (id: string): FocusSubscriber => {
    const onData: FocusSubscriber = (data) => {
      if (data.type === 'output') {
        // Chunk so each sealed frame's plaintext stays under the FFI buffer.
        for (let i = 0; i < data.chunk.length; i += MAX_OUTPUT_CHARS) {
          if (
            !sendSealed({
              t: 'output',
              chunk: data.chunk.slice(i, i + MAX_OUTPUT_CHARS),
              id: data.id,
            })
          )
            break;
        }
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
      // Race the next inbound frame against a fatal seal/send failure so the
      // loop tears down even while blocked on recv().
      const next = await Promise.race([
        io.recv().then((frame) => ({ frame }) as const),
        fatal.then(() => ({ fatal: true }) as const),
      ]);
      if ('fatal' in next) return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(decoder.decode(channel.open(next.frame))) as ClientMessage;
      } catch (err) {
        // A frame we can't decrypt or parse means the stream is unusable.
        logError('Noise session: decrypt/parse failed, ending session:', err);
        return;
      }
      await applyMessage(msg, d, attachments, makeSubscriber);
    }
  } catch {
    // io.recv() rejected (socket closed) — fall through to cleanup.
  } finally {
    cleanup();
  }
}
