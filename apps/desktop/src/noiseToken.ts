import { isNoiseHost, noiseSessionAddress } from './noiseHosts';

export type MintedToken = { token: string; expiresAt: string };
export type MintFn = (hostId: string, address: string) => Promise<MintedToken>;

export type TokenCacheOptions = {
  mint: MintFn;
  /** Epoch milliseconds. Injected so expiry tests do not wait on wall time. */
  now?: () => number;
  /** Refresh this far through the token's lifetime. Spec §6: 90%. */
  refreshAt?: number;
};

type Entry = {
  token: string;
  cachedAtMs: number;
  expiresAtMs: number;
};

export type TokenCache = {
  getToken(hostId: string, address: string): Promise<string>;
  invalidate(hostId: string): void;
};

/**
 * In-memory per-host device-token cache. Reuses a minted token until 90% of
 * its lifetime (by `expiresAt`), then remints. `invalidate` is the 401 path.
 */
export function createTokenCache(opts: TokenCacheOptions): TokenCache {
  const now = opts.now ?? Date.now;
  const refreshAt = opts.refreshAt ?? 0.9;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<string>>();

  function isFresh(entry: Entry, at: number): boolean {
    const lifetime = entry.expiresAtMs - entry.cachedAtMs;
    const refreshMs = entry.cachedAtMs + lifetime * refreshAt;
    return at < refreshMs;
  }

  async function mintAndStore(hostId: string, address: string): Promise<string> {
    const minted = await opts.mint(hostId, address);
    const cachedAtMs = now();
    const parsed = Date.parse(minted.expiresAt);
    const expiresAtMs = Number.isFinite(parsed) ? parsed : cachedAtMs + 86_400_000;
    cache.set(hostId, { token: minted.token, cachedAtMs, expiresAtMs });
    return minted.token;
  }

  async function getToken(hostId: string, address: string): Promise<string> {
    const entry = cache.get(hostId);
    if (entry && isFresh(entry, now())) return entry.token;

    const pending = inflight.get(hostId);
    if (pending) return pending;

    const promise = mintAndStore(hostId, address).finally(() => {
      inflight.delete(hostId);
    });
    inflight.set(hostId, promise);
    return promise;
  }

  function invalidate(hostId: string): void {
    cache.delete(hostId);
  }

  return { getToken, invalidate };
}

let defaultCache: TokenCache | null = null;

function defaultMint(hostId: string, address: string): Promise<MintedToken> {
  return import('./coreApi').then((mod) => mod.coreNoiseToken(hostId, address));
}

function defaultTokenCache(): TokenCache {
  if (!defaultCache) {
    defaultCache = createTokenCache({ mint: defaultMint });
  }
  return defaultCache;
}

/** Mint (or reuse) a device token for `hostId`. */
export function getToken(hostId: string, address: string): Promise<string> {
  return defaultTokenCache().getToken(hostId, address);
}

/** Drop the cached token so the next `getToken` remints (the 401 path). */
export function invalidateToken(hostId: string): void {
  defaultTokenCache().invalidate(hostId);
}

/**
 * Bearer value for a REST call: a minted device token on a Noise host, the
 * shared password otherwise. Additive — password hosts are unchanged.
 */
export async function restBearer(
  hostId: string,
  host: string,
  port: string,
  password: string,
): Promise<string> {
  if (isNoiseHost(hostId)) {
    return getToken(hostId, noiseSessionAddress(host, port));
  }
  return password;
}
