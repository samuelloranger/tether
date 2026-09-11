export type PairScheme = 'http' | 'https';

/**
 * A host's transport, so REST and the Noise socket agree. The scheme is
 * captured at pairing and stored on the HostProfile; `undefined` on profiles
 * saved before the field existed, where the port is the fallback (443/8443 →
 * `https`). A raw IP on 8085 is plaintext, a TLS-fronted domain is `https`.
 */
export function resolveScheme(scheme: string | undefined | null, port: string): PairScheme {
  if (scheme === 'http' || scheme === 'https') return scheme;
  return port === '443' || port === '8443' ? 'https' : 'http';
}
