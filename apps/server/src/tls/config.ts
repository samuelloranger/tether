// Which listeners the daemon opens, resolved from the environment.
//
// ## Why this is not a client-editable setting
//
// Everything in `config.ts` can be PATCHed by any authenticated client. TLS
// cannot live there: a phone that turns the plaintext listener off has just
// locked out every other client on the LAN, including the desktop app it cannot
// reach to fix it, and the only recovery is shell access to the host. The same
// argument runs the other way — a compromised token that turns TLS off downgrades
// every peer silently. So the listener topology is host-side configuration
// (environment at daemon start), and the API only *reports* it.
//
// ## Backward compatibility
//
// Default is `both`: plaintext on TETHER_PORT exactly as before, TLS added
// alongside on TETHER_TLS_PORT. A user who runs `tether update` without reading
// the release notes sees zero behavioural change on the port their shipping
// clients already use, and gains an HTTPS port that new clients can pin. Cutover
// to `TETHER_TLS=only` is theirs to make, once their clients speak it.

export type TlsMode = 'both' | 'only' | 'off';

export type ListenerPlan = {
  mode: TlsMode;
  /** Plaintext port, or null when the plaintext listener is disabled. */
  httpPort: number | null;
  /** TLS port, or null when TLS is disabled. */
  httpsPort: number | null;
  /** Non-fatal problems worth logging at boot. */
  warnings: string[];
};

export const DEFAULT_HTTP_PORT = 8085;
export const DEFAULT_HTTPS_PORT = 8443;

function readPort(raw: string | undefined, fallback: number, label: string, warnings: string[]) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    warnings.push(`Ignoring invalid ${label}="${raw}"; using ${fallback}.`);
    return fallback;
  }
  return port;
}

export function parseTlsMode(raw: string | undefined, warnings: string[]): TlsMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'both';
  // Tolerate the shapes people actually type into a shell.
  if (['both', 'on', '1', 'true', 'yes'].includes(value)) return 'both';
  if (['only', 'https', 'https-only', 'strict'].includes(value)) return 'only';
  if (['off', '0', 'false', 'no', 'none', 'http'].includes(value)) return 'off';
  warnings.push(`Ignoring unknown TETHER_TLS="${raw}"; using "both".`);
  return 'both';
}

export function resolveListenerPlan(env: NodeJS.ProcessEnv = process.env): ListenerPlan {
  const warnings: string[] = [];
  const mode = parseTlsMode(env.TETHER_TLS, warnings);
  const httpPort = readPort(env.TETHER_PORT, DEFAULT_HTTP_PORT, 'TETHER_PORT', warnings);
  let httpsPort = readPort(env.TETHER_TLS_PORT, DEFAULT_HTTPS_PORT, 'TETHER_TLS_PORT', warnings);

  if (mode !== 'off' && httpsPort === httpPort) {
    // One socket cannot be both. Whichever the user meant, "keep the shipping
    // clients working" is the safer guess, so plaintext keeps the port and TLS
    // is what gets dropped.
    warnings.push(
      `TETHER_TLS_PORT (${httpsPort}) equals TETHER_PORT; disabling TLS. ` +
        'Give the TLS listener a port of its own, or set TETHER_TLS=only.',
    );
    httpsPort = -1;
  }

  if (mode === 'only' && httpsPort !== -1) {
    return { mode, httpPort: null, httpsPort, warnings };
  }
  if (mode === 'off' || httpsPort === -1) {
    return { mode: 'off', httpPort, httpsPort: null, warnings };
  }
  return { mode: 'both', httpPort, httpsPort, warnings };
}

/** What `/api/status` and `/api/config` report about transport. Read-only. */
export type TlsReport = {
  /** Is a TLS listener open at all? */
  enabled: boolean;
  /** Is the plaintext listener still open? */
  plaintext: boolean;
  port: number | null;
  /** `sha256:<hex>` over the certificate DER, or null when TLS is off. */
  fingerprint: string | null;
};

export function tlsReport(plan: ListenerPlan, fingerprintSha256: string | null): TlsReport {
  const enabled = plan.httpsPort !== null && fingerprintSha256 !== null;
  return {
    enabled,
    plaintext: plan.httpPort !== null,
    port: enabled ? plan.httpsPort : null,
    fingerprint: enabled ? `sha256:${fingerprintSha256}` : null,
  };
}
