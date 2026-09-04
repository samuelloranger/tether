import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { runReconnect } from '../authGate';
import { getDeviceByPubkey, touchDevice } from '../deviceRegistry';
import { logError, logInfo } from '../log';
import { ChannelError } from '../noiseChannel';
import { loadOrCreateServerKeypair } from '../noiseIdentity';
import { runNoiseSession } from '../noiseSessionProtocol';
import { toFrameBytes, WsFrameIO, type WsSender } from '../noiseWsAdapter';
import { handlePairingConnection } from '../pairControl';

export const noiseRoutes = new Hono();

// Public (pre-auth-reachable) endpoints: bound how many Noise sockets can be
// mid-flight at once, and kill an upgrade whose handshake stalls, so idle/hostile
// connections can't pin file descriptors + native handshake handles.
const MAX_NOISE_CONNECTIONS = 64;
const HANDSHAKE_TIMEOUT_MS = 10_000;
let activeNoiseConnections = 0;

/** Reject a handshake that does not complete within `ms`, running `onTimeout`. */
function withHandshakeTimeout<T>(p: Promise<T>, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new ChannelError('handshake'));
    }, HANDSHAKE_TIMEOUT_MS);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * The Noise WebSocket front door. These two routes are the ONLY `/api/*`
 * endpoints that bypass the shared-password `authMiddleware` (they are listed in
 * `PUBLIC_API_PATHS`): the Noise handshake — pairing PSK, then a pinned static
 * key on reconnect — IS their authentication, so there is no password here.
 *
 * Both routes are pure byte pipes: `onMessage` feeds the raw binary frame into a
 * `WsFrameIO`, the handshake/session logic pulls frames with `io.recv()` and
 * writes with `io.send()`, and `onClose` fails any pending `recv` so the driver
 * unwinds.
 */

// hono/bun hands WS frames to onMessage as a MessageEvent-like { data }. Binary
// arrives as an ArrayBuffer (or, in some builds, a typed-array view); a text
// frame is a protocol error for the binary Noise stream and is ignored.
function pushFrame(io: WsFrameIO, data: unknown): void {
  const bytes = toFrameBytes(data);
  if (bytes) io.push(bytes);
}

// The WSContext.send accepts a plain Uint8Array; wrap it as the minimal sink the
// adapter needs. The cast bridges WSContext's `Uint8Array<ArrayBuffer>` param to
// the adapter's plain `Uint8Array` — seal() output is always ArrayBuffer-backed.
function sink(ws: { send: (data: Uint8Array<ArrayBuffer>) => void }): WsSender {
  return { send: (data) => ws.send(data as Uint8Array<ArrayBuffer>) };
}

// GET /api/noise/pair — run the XXpsk2 pairing handshake + host confirm + enroll
// against the current enrollment window. There is no established channel for the
// client to read a sealed reply from, so the outcome is a small PLAINTEXT JSON
// frame ({ ok:true } / { ok:false, error }) followed by a socket close.
noiseRoutes.get(
  '/api/noise/pair',
  upgradeWebSocket(() => {
    let io: WsFrameIO | null = null;
    return {
      onOpen(_evt, ws) {
        if (activeNoiseConnections >= MAX_NOISE_CONNECTIONS) {
          try {
            ws.close(1013); // Try Again Later
          } catch {}
          return;
        }
        activeNoiseConnections += 1;
        const adapter = new WsFrameIO(sink(ws));
        io = adapter;
        withHandshakeTimeout(handlePairingConnection(adapter), () => adapter.close())
          .then((res) => {
            logInfo(`Noise pairing enrolled device ${res.pubkey}`);
            ws.send(JSON.stringify({ ok: true }));
            ws.close();
          })
          .catch((err) => {
            const error = err instanceof ChannelError ? err.code : 'error';
            if (!(err instanceof ChannelError)) {
              logError('Noise pairing failed:', err);
            }
            try {
              ws.send(JSON.stringify({ ok: false, error }));
            } catch {}
            ws.close();
          })
          .finally(() => {
            adapter.close();
            activeNoiseConnections -= 1;
          });
      },
      onMessage(evt) {
        if (io) pushFrame(io, evt.data);
      },
      onClose() {
        io?.close();
      },
    };
  }),
);

// GET /api/noise/session — accept a device's IK reconnect, authorize it against
// the device registry (an unknown/revoked key is refused before any transport),
// then run the sealed terminal session protocol over the established channel.
noiseRoutes.get(
  '/api/noise/session',
  upgradeWebSocket(() => {
    let io: WsFrameIO | null = null;
    return {
      onOpen(_evt, ws) {
        if (activeNoiseConnections >= MAX_NOISE_CONNECTIONS) {
          try {
            ws.close(1013); // Try Again Later
          } catch {}
          return;
        }
        activeNoiseConnections += 1;
        const adapter = new WsFrameIO(sink(ws));
        io = adapter;
        const priv = loadOrCreateServerKeypair().priv;
        // Only the handshake is time-bounded; an established session runs as long
        // as the client keeps it open.
        withHandshakeTimeout(runReconnect(adapter, priv, { getDeviceByPubkey, touchDevice }), () =>
          adapter.close(),
        )
          .then(async ({ channel, device }) => {
            logInfo(`Noise session authorized device ${device.id}`);
            try {
              await runNoiseSession(channel, adapter);
            } finally {
              channel.free();
              try {
                ws.close();
              } catch {}
            }
          })
          .catch((err) => {
            // Fail closed: an unknown/revoked key never entered transport mode.
            // Close without a body (1008 Policy Violation) so nothing leaks
            // whether the key is unknown vs. the handshake simply failed.
            if (!(err instanceof ChannelError)) {
              logError('Noise session setup failed:', err);
            }
            try {
              ws.close(1008);
            } catch {}
          })
          .finally(() => {
            adapter.close();
            activeNoiseConnections -= 1;
          });
      },
      onMessage(evt) {
        if (io) pushFrame(io, evt.data);
      },
      onClose() {
        io?.close();
      },
    };
  }),
);
