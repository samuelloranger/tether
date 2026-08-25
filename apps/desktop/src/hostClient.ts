import type { SessionActivity } from './activity';
import type { HostProfile } from './hostStore';
import { authHeaders } from './secureConfig';

export interface TetherSession {
  id: string;
  status: 'running' | 'stopped';
  last_output_at: string | null;
  name?: string | null;
  auto_title?: string | null;
  activity?: SessionActivity | null;
}

export interface HostClient {
  profile: HostProfile;
  baseUrl: string;
  wsOrigin: string;
  password: string;
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, init?: RequestInit): Promise<Response>;
}

function mergeAuth(password: string, headers?: HeadersInit): Headers {
  const merged = new Headers(headers);
  for (const [key, value] of Object.entries(authHeaders(password))) merged.set(key, value);
  return merged;
}

export function createHostClient(profile: HostProfile, password: string): HostClient {
  const baseUrl = `http://${profile.host}:${profile.port}`;
  const wsOrigin = `ws://${profile.host}:${profile.port}`;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: mergeAuth(password, init.headers),
    });

  return {
    profile,
    baseUrl,
    wsOrigin,
    password,
    get: request,
    post: (path, init = {}) => request(path, { ...init, method: init.method ?? 'POST' }),
  };
}

export async function testConnection(
  client: HostClient,
  password: string,
  confirmPassword: string,
): Promise<{ ok: true } | { ok: false; msg: string; needsSetup: boolean }> {
  try {
    const status = await client.get('/api/status', { signal: AbortSignal.timeout(5000) });
    if (!status.ok) throw new Error('Server is unavailable.');
    const body = (await status.json()) as { needsSetup?: unknown };
    const needsSetup = Boolean(body.needsSetup);
    if (!password) {
      return {
        ok: false,
        needsSetup,
        msg: needsSetup ? 'Choose a password for this server.' : 'Enter the server password.',
      };
    }
    if (needsSetup) {
      if (password !== confirmPassword) throw new Error('Passwords do not match.');
      const setup = await client.post('/api/setup', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(5000),
      });
      if (setup.status === 409) throw new Error('Already set up. Enter the existing password.');
      if (!setup.ok) throw new Error('Setup failed — try again.');
    } else {
      const health = await client.get('/api/health', { signal: AbortSignal.timeout(5000) });
      if (health.status === 401) throw new Error('Wrong password.');
      if (!health.ok) throw new Error(`Server error (${health.status}).`);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      needsSetup: false,
      msg: error instanceof Error ? error.message : 'Unreachable — check the host and port.',
    };
  }
}

export async function fetchSessions(client: HostClient): Promise<TetherSession[]> {
  const response = await client.get('/api/sessions');
  if (response.status === 401) throw new Error('Wrong password.');
  if (!response.ok) throw new Error(`Session list failed (${response.status}).`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Session response was not an array.');
  return rows as TetherSession[];
}

export function nextTermId(existing: string[]): string {
  let max = 0;
  for (const id of existing) {
    const match = /^term-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `term-${max + 1}`;
}

export async function killSession(client: HostClient, id: string): Promise<void> {
  await client.post('/api/sessions/kill', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

export async function renameSession(client: HostClient, id: string, name: string): Promise<void> {
  await client.post('/api/sessions/rename', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name }),
  });
}

export async function startSession(client: HostClient, id: string): Promise<void> {
  await client.post('/api/sessions/start', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}
