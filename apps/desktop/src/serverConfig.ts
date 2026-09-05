import {
  coreAdminRestart,
  coreAdminTestNotification,
  coreAdminUpdate,
  coreConfigGet,
  coreConfigPatch,
  coreHealthVersion,
} from './coreApi';
import type { ServerConfig, ServerConfigPatch } from './serverSettingsModel';

export async function loadServerConfig(hostId: string): Promise<ServerConfig> {
  return coreConfigGet(hostId);
}

export async function patchServerConfig(
  hostId: string,
  patch: ServerConfigPatch,
): Promise<ServerConfig> {
  return coreConfigPatch(hostId, patch);
}

export async function sendServerNotificationTest(hostId: string): Promise<void> {
  await coreAdminTestNotification(hostId);
}

export async function updateServer(hostId: string, current: string): Promise<void> {
  await coreAdminUpdate(hostId, current);
}

export async function restartServer(hostId: string, current: string): Promise<void> {
  await coreAdminRestart(hostId, current);
}

export async function loadServerVersion(hostId: string): Promise<string | null> {
  return coreHealthVersion(hostId);
}
