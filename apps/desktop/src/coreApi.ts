import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { normalizeInvokeError } from './invokeError';
import type { ServerConfig, ServerConfigPatch } from './serverSettingsModel';
import type { DrawerSession, HostHealthStatus, HostProfile } from './types';

/// Every core command goes through here so a failure arrives as an Error with
/// the Rust message intact. Tauri rejects with a bare string, which the UI's
/// `err instanceof Error` checks silently discarded.
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw normalizeInvokeError(error);
  }
}

export async function coreHostsMigrate(profilesJson: string | null): Promise<HostProfile[]> {
  return invoke<HostProfile[]>('core_hosts_migrate', {
    profilesJson,
  });
}

export async function coreHostsList(): Promise<HostProfile[]> {
  return invoke<HostProfile[]>('core_hosts_list');
}

export async function coreHostsSave(input: {
  id?: string;
  name: string;
  host: string;
  port: string;
  password: string;
  confirmPassword?: string;
}): Promise<HostProfile> {
  return invoke<HostProfile>('core_hosts_save', {
    id: input.id ?? null,
    name: input.name,
    host: input.host,
    port: input.port,
    password: input.password,
    confirmPassword: input.confirmPassword ?? '',
  });
}

export async function coreHostsRemove(hostId: string): Promise<void> {
  await invoke('core_hosts_remove', { hostId });
}

export async function coreTestConnection(input: {
  host: string;
  port: string;
  password: string;
  confirmPassword?: string;
}): Promise<{ ok: boolean; msg?: string; needsSetup?: boolean }> {
  return invoke('core_test_connection', {
    host: input.host,
    port: input.port,
    password: input.password,
    confirmPassword: input.confirmPassword ?? '',
  });
}

export async function coreNextTermId(existing: string[]): Promise<string> {
  return invoke<string>('core_next_term_id', { existing });
}

export async function coreSessionsKill(input: {
  hostId: string;
  sessionId: string;
  activeHostId: string | null;
  activeSessionId: string | null;
  drawerSessions: Array<{ hostId: string; id: string }>;
}): Promise<string | null> {
  return invoke<string | null>('core_sessions_kill', {
    hostId: input.hostId,
    sessionId: input.sessionId,
    activeHostId: input.activeHostId,
    activeSessionId: input.activeSessionId,
    drawerSessions: input.drawerSessions,
  });
}

/** One host's session list, fetched now rather than read off the poll. */
export async function coreSessionsList(hostId: string): Promise<DrawerSession[]> {
  return invoke<DrawerSession[]>('core_sessions_list', { hostId });
}

export async function coreSessionsRename(
  hostId: string,
  sessionId: string,
  name: string,
): Promise<void> {
  await invoke('core_sessions_rename', { hostId, sessionId, name });
}

export async function corePollingStart(): Promise<void> {
  await invoke('core_polling_start');
}

export async function corePollingStop(): Promise<void> {
  await invoke('core_polling_stop');
}

export async function corePollingRestart(): Promise<void> {
  await invoke('core_polling_restart');
}

export async function corePollingSetActive(hostId: string | null): Promise<void> {
  await invoke('core_polling_set_active', { hostId });
}

export async function coreHostRetry(hostId: string): Promise<void> {
  await invoke('core_host_retry', { hostId });
}

export interface DetectedLinkSpan {
  start: number;
  end: number;
  target:
    | { kind: 'external'; url: string }
    | { kind: 'file'; path: string; line?: number; column?: number };
}

export async function coreDetectLinks(
  texts: string[],
  wrapped: boolean[],
): Promise<DetectedLinkSpan[][]> {
  return invoke<DetectedLinkSpan[][]>('core_detect_links', { texts, wrapped });
}

export async function coreOpenExternal(url: string): Promise<void> {
  await invoke('open_external', { url });
}

export async function coreOsc52Decode(data: string): Promise<string | null> {
  return invoke<string | null>('core_osc52_decode', { data });
}

export async function coreMouseCell(input: {
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
}): Promise<{ col: number; row: number }> {
  return invoke<{ col: number; row: number }>('core_mouse_cell', { args: input });
}

export async function coreMouseEncode(input: {
  kind: string;
  col: number;
  row: number;
  mode: string;
  sgr: boolean;
  btn: number;
  mods: number;
}): Promise<string[]> {
  return invoke<string[]>('core_mouse_encode', { args: input });
}

export async function coreCacheTouch(id: string): Promise<string | null> {
  return invoke<string | null>('core_cache_touch', { id });
}

export async function coreCacheDelete(id: string): Promise<void> {
  await invoke('core_cache_delete', { id });
}

export async function coreCacheIds(): Promise<string[]> {
  return invoke<string[]>('core_cache_ids');
}

export function listenHostHealth(
  handler: (hostId: string, status: HostHealthStatus) => void,
): Promise<UnlistenFn> {
  return listen<{ hostId: string; status: HostHealthStatus }>('core-host-health', (event) => {
    handler(event.payload.hostId, event.payload.status);
  });
}

export function listenSessions(
  handler: (hostId: string, sessions: DrawerSession[]) => void,
): Promise<UnlistenFn> {
  return listen<{ hostId: string; sessions: DrawerSession[] }>('core-sessions', (event) => {
    handler(event.payload.hostId, event.payload.sessions);
  });
}

export async function coreConfigGet(hostId: string): Promise<ServerConfig> {
  return invoke<ServerConfig>('core_config_get', { hostId });
}

export async function coreConfigPatch(
  hostId: string,
  patch: ServerConfigPatch,
): Promise<ServerConfig> {
  return invoke<ServerConfig>('core_config_patch', { hostId, patch });
}

export async function coreAdminChangePassword(
  hostId: string,
  current: string,
  next: string,
): Promise<void> {
  await invoke('core_admin_change_password', { hostId, current, next });
}

export async function coreAdminUpdate(hostId: string, current: string): Promise<void> {
  await invoke('core_admin_update', { hostId, current });
}

export async function coreAdminRestart(hostId: string, current: string): Promise<void> {
  await invoke('core_admin_restart', { hostId, current });
}

export async function coreAdminTestNotification(hostId: string): Promise<void> {
  await invoke('core_admin_test_notification', { hostId });
}

export async function coreHealthVersion(hostId: string): Promise<string | null> {
  return invoke<string | null>('core_health_version', { hostId });
}

export async function coreHostsUpdateIdentity(
  hostId: string,
  identity: { name: string; color: string },
): Promise<HostProfile> {
  return invoke<HostProfile>('core_hosts_update_identity', { hostId, identity });
}

export async function coreHostsUpdateConnection(
  hostId: string,
  update: { host: string; port: string; replacementPassword?: string },
): Promise<HostProfile> {
  return invoke<HostProfile>('core_hosts_update_connection', {
    hostId,
    update: {
      host: update.host,
      port: update.port,
      replacementPassword: update.replacementPassword ?? null,
    },
  });
}

export type DeepLinkResolveResult =
  | { kind: 'matched'; hostId: string; sessionId: string }
  | { kind: 'unknownHost'; identityName: string }
  | { kind: 'invalid' };

export async function coreDeepLinkResolve(url: string): Promise<DeepLinkResolveResult> {
  return invoke<DeepLinkResolveResult>('core_deep_link_resolve', { url });
}

export async function coreNotifyDecide(edge: {
  notifyFired: boolean;
  bellFired: boolean;
  oscTitle: string;
  oscBody: string;
  label: string;
  notificationsEnabled: boolean;
  sessionIsActive: boolean;
  windowFocused: boolean;
}): Promise<{ shouldNotify: boolean; title?: string; body?: string }> {
  return invoke('core_notify_decide', { edge });
}

export async function coreNotifyWaitingEdge(
  prevActivity: string | null | undefined,
  nextActivity: string | null | undefined,
  isActive: boolean,
): Promise<boolean> {
  return invoke<boolean>('core_notify_waiting_edge', {
    prevActivity: prevActivity ?? null,
    nextActivity: nextActivity ?? null,
    isActive,
  });
}
