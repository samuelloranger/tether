import { validateAddress } from './address';
import type { PairScheme } from './hostScheme';

const DEFAULT_HTTP_PORT = '8085';
const DEFAULT_HTTPS_PORT = '443';

/**
 * Accepts `host`, `host:port`, or a `ws://` / `http://` URL with an optional
 * path; the path is dropped and replaced with the pairing endpoint.
 */
export function parsePairAddress(
  input: string,
):
  | { ok: true; scheme: PairScheme; host: string; port: string; wsAddress: string }
  | { ok: false; reason: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'Enter a server host or IP.' };

  let explicitScheme: PairScheme | null = null;
  let rest = trimmed;

  const schemeMatch = /^(\w+):\/\//i.exec(trimmed);
  if (schemeMatch) {
    const rawScheme = schemeMatch[1].toLowerCase();
    if (!['http', 'https', 'ws', 'wss'].includes(rawScheme)) {
      return { ok: false, reason: 'Enter a server host or IP.' };
    }
    explicitScheme = rawScheme === 'https' || rawScheme === 'wss' ? 'https' : 'http';
    rest = trimmed.slice(schemeMatch[0].length);
  }

  const slash = rest.indexOf('/');
  if (slash >= 0) rest = rest.slice(0, slash);
  if (!rest) return { ok: false, reason: 'Enter a server host or IP.' };

  let host = rest;
  let port: string | null = null;
  const colon = rest.lastIndexOf(':');
  if (colon >= 0) {
    host = rest.slice(0, colon);
    port = rest.slice(colon + 1);
  }

  const valid = validateAddress(host, port ?? DEFAULT_HTTP_PORT);
  if (!valid.ok) return { ok: false, reason: valid.reason };

  const finalPort = port ?? (explicitScheme === 'https' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT);

  let scheme: PairScheme;
  if (explicitScheme !== null) {
    scheme = explicitScheme;
  } else if (port) {
    scheme = port === '443' || port === '8443' ? 'https' : 'http';
  } else {
    scheme = 'http';
  }

  const wsProto = scheme === 'https' ? 'wss' : 'ws';
  const wsAddress = `${wsProto}://${host}:${finalPort}/api/noise/pair`;

  return { ok: true, scheme, host, port: finalPort, wsAddress };
}
