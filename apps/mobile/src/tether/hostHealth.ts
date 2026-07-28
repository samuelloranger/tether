export type HostHealthStatus = 'unknown' | 'reachable' | 'unreachable' | 'unauthorized';

export type HostHealth = {
  status: HostHealthStatus;
  failures: number;
};

const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;

export function initialHostHealth(): HostHealth {
  return { status: 'unknown', failures: 0 };
}

export function hostHealthAfterFailure(health: HostHealth): HostHealth {
  if (health.status === 'unauthorized') return health;
  return { status: 'unreachable', failures: health.failures + 1 };
}

export function hostHealthAfterResponse(health: HostHealth, status: number): HostHealth {
  if (status >= 200 && status < 300) return { status: 'reachable', failures: 0 };
  if (status === 401) return { status: 'unauthorized', failures: 0 };
  return hostHealthAfterFailure(health);
}

export function shouldPollHost(health: HostHealth): boolean {
  return health.status !== 'unauthorized';
}

export function nextHostPollDelay(health: HostHealth, normalIntervalMs: number): number | null {
  if (!shouldPollHost(health)) return null;
  if (health.status !== 'unreachable') return normalIntervalMs;
  return Math.min(INITIAL_BACKOFF_MS * 2 ** (health.failures - 1), MAX_BACKOFF_MS);
}
