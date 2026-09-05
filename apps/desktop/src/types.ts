import type { SessionActivity } from './activity';
import { hostScheme } from './hostScheme';

export const KEY_ACTIVE_HOST = 'tether_active_host';
export const HOST_PROFILES_KEY = 'tether_host_profiles';

export interface HostProfile {
  id: string;
  name: string;
  color: string;
  host: string;
  port: string;
  identityName: string;
  order: number;
}

export type HostHealthStatus = 'unknown' | 'reachable' | 'unreachable' | 'unauthorized';

export interface DrawerSession {
  hostId: string;
  id: string;
  status: 'running' | 'stopped';
  last_output_at: string | null;
  name?: string | null;
  auto_title?: string | null;
  activity?: SessionActivity | null;
}

export function activeSessionStorageKey(hostId: string): string {
  return `tether_session_id_${hostId}`;
}

export function httpOriginFor(profile: HostProfile): string {
  return `${hostScheme(profile.id, profile.port)}://${profile.host}:${profile.port}`;
}
