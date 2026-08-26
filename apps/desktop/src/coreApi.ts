import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DrawerSession, HostHealthStatus, HostProfile } from './types';

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
