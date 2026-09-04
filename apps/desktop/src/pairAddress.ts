import { validateAddress } from './address';

const DEFAULT_PORT = '8085';

/**
 * Turn a host address the user typed on the pairing screen into the pieces the
 * flow needs: the host + port for the persisted profile, and the WebSocket URL
 * the Noise pairing handshake connects to (`core_noise_pair`'s `address`, which
 * `NoiseWs::connect` hands straight to tokio-tungstenite).
 *
 * Accepts `host`, `host:port`, or a `ws://` / `http://` URL with an optional
 * path; the path is dropped and replaced with the pairing endpoint. Port
 * defaults to 8085. Reuses `validateAddress` so the rules match the host form.
 */
export function parsePairAddress(
  input: string,
): { ok: true; host: string; port: string; wsAddress: string } | { ok: false; reason: string } {
  let rest = input.trim().replace(/^(wss?|https?):\/\//i, '');
  const slash = rest.indexOf('/');
  if (slash >= 0) rest = rest.slice(0, slash);
  if (!rest) return { ok: false, reason: 'Enter a server host or IP.' };

  let host = rest;
  let port = DEFAULT_PORT;
  const colon = rest.lastIndexOf(':');
  if (colon >= 0) {
    host = rest.slice(0, colon);
    port = rest.slice(colon + 1);
  }

  const valid = validateAddress(host, port);
  if (!valid.ok) return { ok: false, reason: valid.reason };

  return { ok: true, host, port, wsAddress: `ws://${host}:${port}/api/noise/pair` };
}
