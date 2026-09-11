import type { HostHealthStatus } from '@/core/types';

/**
 * Host ids that just crossed into `reachable`.
 *
 * The drawer hydrate and last-terminal restore run once at startup; a host that
 * was still coming up then (VPN not yet connected, server mid-restart, keyring
 * not ready) left the drawer blank with no second attempt. Comparing the prior
 * health map against the current one names exactly the hosts to redo that work
 * for — an edge, so a host that stays reachable is not re-pulled every tick.
 */
export function hostsBecomingReachable(
  previous: Record<string, HostHealthStatus>,
  current: Record<string, HostHealthStatus>,
): string[] {
  return Object.keys(current).filter((id) => current[id] === 'reachable' && previous[id] !== 'reachable');
}
