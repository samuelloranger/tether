import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { runReconnect } from '../authGate';
import { trackDeviceChannel } from '../deviceChannels';
import { getDeviceByPubkey, touchDevice } from '../deviceRegistry';
import { logError, logInfo } from '../log';
import { ChannelError } from '../noiseChannel';
import { loadOrCreateServerKeypair } from '../noiseIdentity';
import { runNoiseSession } from '../noiseSessionProtocol';
import { toFrameBytes, WsFrameIO, type WsSender } from '../noiseWsAdapter';
import { handlePairingConnection } from '../pairControl';

export const noiseRoutes = new Hono();

// Public (pre-auth-reachable): bound in-flight Noise sockets and kill stalled
// handshakes so idle/hostile connections can't pin fds + native handles.
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
 * The Noise WebSocket front door: the ONLY /api/* routes that bypass bearer auth
 * (in PUBLIC_API_PATHS) — the Noise handshake IS their authentication.
 */

// Binary WS frames arrive as ArrayBuffer (or a typed-array view in some builds);
// a text frame is a protocol error for the binary Noise stream and is ignored.
function pushFrame(io: WsFrameIO, data: unknown): void {
  const bytes = toFrameBytes(data);
  if (bytes) io.push(bytes);
}

// Wrap WSContext.send as the sink the adapter needs; the cast bridges its
// Uint8Array<ArrayBuffer> param to the plain Uint8Array — seal() is always that.
function sink(ws: { send: (data: Uint8Array<ArrayBuffer>) => void }): WsSender {
  return { send: (data) => ws.send(data as Uint8Array<ArrayBuffer>) };
}

// GET /api/noise/pair — XXpsk2 pairing + host confirm + enroll. No established
// channel exists yet, so the outcome is a small PLAINTEXT JSON frame, then close.
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
        // No outer timeout: pairing includes a human confirm step, so acceptPairing
        // bounds handshake and confirm separately; an outer one tears down mid-approval.
        handlePairingConnection(adapter)
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

// GET /api/noise/session — accept a device's IK reconnect, authorize its key
// against the registry (unknown/revoked refused pre-transport), then run sealed.
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
            const untrack = trackDeviceChannel(device.id, () => {
              try {
                adapter.close();
              } catch {}
              try {
                ws.close();
              } catch {}
            });
            try {
              // Thread the authorized device's id in so `devices.list` can flag
              // the caller's own row (`isSelf`); registry fns default to live.
              await runNoiseSession(channel, adapter, { identity: { deviceId: device.id } });
            } finally {
              untrack();
              channel.free();
              try {
                ws.close();
              } catch {}
            }
          })
          .catch((err) => {
            // Fail closed: close without a body (1008) so nothing leaks whether
            // the key is unknown vs. the handshake simply failed.
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
