import { resolveScheme } from './hostScheme';
import type { HostProfile } from './types';

// Which hosts authenticate over Noise. There is no `authMode` field on HostProfile
// yet, so we record a host as "noise" when it is created through the pairing flow
// and read it back where a terminal connection must pick its transport. Backed by
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
    // storage unavailable (private window / blocked) — noise routing just
    // cannot mark the host for this session.
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

/**
 * The Noise session endpoint for a host — where `core_noise_connect` reconnects.
 *
 * Reads the same recorded scheme REST does, so a host paired over TLS is dialled
 * `wss://` rather than plaintext (which the server rejects).
 */
export function noiseSessionAddress(profile: HostProfile): string {
  const proto = resolveScheme(profile.scheme, profile.port) === 'https' ? 'wss' : 'ws';
  return `${proto}://${profile.host}:${profile.port}/api/noise/session`;
}
