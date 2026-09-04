// Which hosts authenticate over Noise (vs a shared password). Interim scheme —
// mirroring the iOS client, there is no `authMode` field on HostProfile yet, so
// we record a host as "noise" when it is created through the pairing flow and
// read it back where a terminal connection must pick its transport. Backed by
// localStorage so it survives reloads; a future persisted authMode can replace it.
const KEY = 'tether_noise_hosts';

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function write(ids: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // storage unavailable (private window / blocked) — noise routing just falls
    // back to the password path for this session, which fails loudly rather than
    // silently mis-streaming, so this is safe to swallow.
  }
}

/** Record `hostId` as a Noise-paired host. Called after a successful pairing. */
export function markNoiseHost(hostId: string): void {
  const ids = read();
  ids.add(hostId);
  write(ids);
}

/** Forget a host's Noise marking (on removal). */
export function unmarkNoiseHost(hostId: string): void {
  const ids = read();
  if (ids.delete(hostId)) write(ids);
}

/** True when `hostId` streams its terminal over Noise instead of the password WS. */
export function isNoiseHost(hostId: string): boolean {
  return read().has(hostId);
}

/** The Noise session endpoint for a host — where `core_noise_connect` reconnects. */
export function noiseSessionAddress(host: string, port: string): string {
  return `ws://${host}:${port}/api/noise/session`;
}
