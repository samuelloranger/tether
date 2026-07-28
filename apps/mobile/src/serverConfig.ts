import type { ServerConfig, ServerConfigPatch } from './serverSettingsModel';
import type { HostClient, HostClientResponse } from './tether/hostClient';

type ErrorBody = { error?: unknown };

async function readBody<T>(response: HostClientResponse): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & ErrorBody;
  if (!response.ok)
    throw new Error(
      typeof body.error === 'string' ? body.error : `Request failed (${response.status})`,
    );
  return body;
}

function json(body: unknown): RequestInit {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function loadServerConfig(client: HostClient): Promise<ServerConfig> {
  return readBody<ServerConfig>(await client.get('/api/config'));
}

export async function patchServerConfig(
  client: HostClient,
  patch: ServerConfigPatch,
): Promise<ServerConfig> {
  return readBody<ServerConfig>(
    await client.post('/api/config', { ...json(patch), method: 'PATCH' }),
  );
}

export async function sendServerNotificationTest(
  client: HostClient,
  patch: Pick<ServerConfigPatch, 'notify'>,
): Promise<void> {
  await readBody<{ ok: true }>(await client.post('/api/admin/test-notification', json(patch)));
}

export async function changeServerPassword(
  client: HostClient,
  current: string,
  next: string,
): Promise<void> {
  await readBody<{ ok: true }>(await client.post('/api/admin/password', json({ current, next })));
}

export async function updateServer(
  client: HostClient,
  current: string,
): Promise<{ targetVersion?: string }> {
  return readBody<{ ok: true; targetVersion?: string }>(
    await client.post('/api/admin/update', json({ current })),
  );
}

export async function restartServer(client: HostClient, current: string): Promise<void> {
  await readBody<{ ok: true }>(await client.post('/api/admin/restart', json({ current })));
}

export async function loadServerVersion(client: HostClient): Promise<string | null> {
  const body = await readBody<{ version?: unknown }>(await client.get('/api/health'));
  return typeof body.version === 'string' ? body.version : null;
}
