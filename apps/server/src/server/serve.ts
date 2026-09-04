import { websocket } from 'hono/bun';
import { app } from './app';
import { resetRunningSessions, setSessionStatus } from './db';
import { logError, logInfo, logWarn } from './log';
import { reattachHolders } from './pty';
import { type ListenerPlan, resolveListenerPlan } from './tlsConfig';
import { publishTlsReport } from './tlsRuntime';
import { ensureTlsMaterial, TLS_DIR, type TlsMaterial } from './tlsStore';

type PeerCapable = { requestIP?: (req: Request) => { address: string } | null };

/**
 * The socket's peer address, or 'unknown'.
 *
 * `requestIP` MUST be invoked as a method on the server. Pulling it into a local
 * and calling it bare loses `this` and Bun throws
 * `ERR_INVALID_THIS: Expected this to be instanceof DebugHTTPServer` — which,
 * from inside `fetch`, turns every single request into a 500. The unit tests do
 * not catch it because they call `app.fetch` directly and never go through
 * `Bun.serve`; only starting the server does.
 */
function peerFromServe(server: unknown, req: Request): string {
  const candidate = server as PeerCapable | null;
  if (!candidate || typeof candidate.requestIP !== 'function') return 'unknown';
  try {
    return candidate.requestIP(req)?.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function baseServeOptions() {
  return {
    hostname: '0.0.0.0',
    // Thread the real socket peer into Hono once for both listeners. Never key
    // auth rate limits on X-Forwarded-For — those headers are spoofable on a
    // direct bind. Pass `server` so hono/bun websocket upgrade still finds it.
    // Second arg typed as `unknown` so Bun.serve still infers websocket data
    // from `websocket` (annotating Bun.Server collapses that generic).
    fetch(req: Request, server: unknown) {
      return app.fetch(req, { peerAddress: peerFromServe(server, req), server });
    },
    websocket,
    error(err: Error) {
      logError('Unhandled request error:', err);
      return new Response('Internal Server Error', { status: 500 });
    },
  };
}

/**
 * Load (or, once, create) the certificate.
 *
 * A failure here must never take the daemon down: the plaintext listener is what
 * every shipping client uses, and a machine the user can no longer reach is a
 * far worse outcome than a machine without TLS. So we degrade to plaintext and
 * say so loudly.
 */
function loadTlsMaterial(plan: ListenerPlan): TlsMaterial | null {
  if (plan.httpsPort === null) return null;
  try {
    const material = ensureTlsMaterial();
    if (material.generated) {
      logInfo(`TLS: generated a self-signed certificate in ${TLS_DIR}`);
    }
    if (new Date(material.notAfter).getTime() < Date.now()) {
      logWarn(
        `TLS: the certificate expired on ${material.notAfter}. It is NOT being rotated ` +
          'automatically, because paired clients pin its fingerprint. To replace it, delete ' +
          `${TLS_DIR} and re-pair every client.`,
      );
    }
    return material;
  } catch (err) {
    logError(`TLS: could not load certificate material — serving plaintext only. ${err}`);
    return null;
  }
}

export async function serve(): Promise<void> {
  const plan = resolveListenerPlan();
  for (const warning of plan.warnings) logWarn(`Config: ${warning}`);

  // A previous server process may have died with sessions still marked running.
  // Their PTYs live in detached holder processes, so first reattach to the ones
  // that survived, then mark whatever is left as stopped.
  resetRunningSessions();
  for (const id of await reattachHolders()) {
    setSessionStatus(id, 'running');
    logInfo(`Reattached to surviving session "${id}"`);
  }

  const tls = loadTlsMaterial(plan);
  // TLS asked for but unavailable: fall back to plaintext rather than exiting.
  // In `only` mode there is no plaintext port to fall back to, so use the
  // default one — locking the user out of their own machine is not an option.
  const httpPort = plan.httpPort ?? (tls === null ? Number(process.env.TETHER_PORT ?? 8085) : null);
  const httpsPort = tls === null ? null : plan.httpsPort;
  if (plan.httpPort === null && tls === null) {
    logWarn(`TLS: requested TETHER_TLS=only without TLS; falling back to :${httpPort} plain.`);
  }

  publishTlsReport({ ...plan, httpPort, httpsPort }, tls?.fingerprintSha256 ?? null);

  if (httpPort !== null) {
    Bun.serve({ ...baseServeOptions(), port: httpPort });
    logInfo(`Tether server listening on :${httpPort} (http)`);
  }
  if (httpsPort !== null && tls) {
    Bun.serve({
      ...baseServeOptions(),
      port: httpsPort,
      tls: { cert: tls.certPem, key: tls.keyPem },
    });
    logInfo(`Tether server listening on :${httpsPort} (https)`);
    logInfo(`TLS certificate fingerprint: sha256:${tls.fingerprintSha256}`);
  }

  logInfo('Auth: /api routes require a per-device bearer token.');

  if (httpPort !== null && httpsPort !== null) {
    logInfo(
      'Transport: TLS on the https port; the http port stays plaintext for older clients. ' +
        'Set TETHER_TLS=only once every client has paired over https.',
    );
  } else if (httpsPort !== null) {
    logInfo('Transport: TLS only. Clients pin the fingerprint above.');
  } else {
    logInfo(
      "Transport: plaintext only — encryption is the tunnel's job (Tailscale / WireGuard / SSH).",
    );
  }
}
