import { websocket } from 'hono/bun';
import { app } from './app';
import { getAuthHash, resetRunningSessions, setSessionStatus } from './db';
import { reattachHolders } from './pty';
import { type ListenerPlan, resolveListenerPlan } from './tlsConfig';
import { publishTlsReport } from './tlsRuntime';
import { ensureTlsMaterial, TLS_DIR, type TlsMaterial } from './tlsStore';

function baseServeOptions() {
  return {
    hostname: '0.0.0.0',
    fetch: app.fetch,
    websocket,
    error(err: Error) {
      console.error('Unhandled request error:', err);
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
      console.log(`TLS: generated a self-signed certificate in ${TLS_DIR}`);
    }
    if (new Date(material.notAfter).getTime() < Date.now()) {
      console.warn(
        `TLS: the certificate expired on ${material.notAfter}. It is NOT being rotated ` +
          'automatically, because paired clients pin its fingerprint. To replace it, delete ' +
          `${TLS_DIR} and re-pair every client.`,
      );
    }
    return material;
  } catch (err) {
    console.error(`TLS: could not load certificate material — serving plaintext only. ${err}`);
    return null;
  }
}

export async function serve(): Promise<void> {
  const plan = resolveListenerPlan();
  for (const warning of plan.warnings) console.warn(`Config: ${warning}`);

  // A previous server process may have died with sessions still marked running.
  // Their PTYs live in detached holder processes, so first reattach to the ones
  // that survived, then mark whatever is left as stopped.
  resetRunningSessions();
  for (const id of await reattachHolders()) {
    setSessionStatus(id, 'running');
    console.log(`Reattached to surviving session "${id}"`);
  }

  const tls = loadTlsMaterial(plan);
  // TLS asked for but unavailable: fall back to plaintext rather than exiting.
  // In `only` mode there is no plaintext port to fall back to, so use the
  // default one — locking the user out of their own machine is not an option.
  const httpPort = plan.httpPort ?? (tls === null ? Number(process.env.TETHER_PORT ?? 8085) : null);
  const httpsPort = tls === null ? null : plan.httpsPort;
  if (plan.httpPort === null && tls === null) {
    console.warn(`TLS: requested TETHER_TLS=only without TLS; falling back to :${httpPort} plain.`);
  }

  publishTlsReport({ ...plan, httpPort, httpsPort }, tls?.fingerprintSha256 ?? null);

  if (httpPort !== null) {
    Bun.serve({ ...baseServeOptions(), port: httpPort });
    console.log(`Tether server listening on :${httpPort} (http)`);
  }
  if (httpsPort !== null && tls) {
    Bun.serve({
      ...baseServeOptions(),
      port: httpsPort,
      tls: { cert: tls.certPem, key: tls.keyPem },
    });
    console.log(`Tether server listening on :${httpsPort} (https)`);
    console.log(`TLS certificate fingerprint: sha256:${tls.fingerprintSha256}`);
  }

  if (getAuthHash()) {
    console.log('Auth: password required on all /api routes.');
  } else {
    console.warn(
      'Auth: NO PASSWORD SET — /api routes will reject all clients. Run: tether set-password',
    );
  }

  if (httpPort !== null && httpsPort !== null) {
    console.log(
      'Transport: TLS on the https port; the http port stays plaintext for older clients. ' +
        'Set TETHER_TLS=only once every client has paired over https.',
    );
  } else if (httpsPort !== null) {
    console.log('Transport: TLS only. Clients pin the fingerprint above.');
  } else {
    console.log(
      "Transport: plaintext only — encryption is the tunnel's job (Tailscale / WireGuard / SSH).",
    );
  }
}
