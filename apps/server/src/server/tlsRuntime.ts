// The listener topology, published by serve() and read by the routes.
//
// A tiny mutable holder rather than an import from serve.ts: app.ts is imported
// *by* serve.ts, and it is also constructed directly by the route tests, which
// never open a socket. Those tests get the default (TLS off) report, which is
// exactly right — there is no TLS listener in a test that never started one.

import { type ListenerPlan, type TlsReport, tlsReport } from './tlsConfig';

const TLS_DISABLED: TlsReport = { enabled: false, plaintext: true, port: null, fingerprint: null };

let current: TlsReport = TLS_DISABLED;

export function publishTlsReport(plan: ListenerPlan, fingerprintSha256: string | null): void {
  current = tlsReport(plan, fingerprintSha256);
}

export function getTlsReport(): TlsReport {
  return current;
}

export function resetTlsReport(): void {
  current = TLS_DISABLED;
}

/**
 * Did this request arrive over TLS?
 *
 * Bun sets the request URL's scheme from the listener the socket landed on, so
 * this is the connection's own property — not a client-supplied header, which is
 * the whole point. `X-Forwarded-Proto` is deliberately ignored: anything that
 * lets a caller *claim* to be secure would let a MITM claim it too.
 */
export function isSecureRequest(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
