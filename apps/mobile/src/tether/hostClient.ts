import { httpBase, wsUrl } from '../address';
import { openTerminalSocket, type TerminalSocket, type TransportHandlers } from '../wsTransport';
import type { HostProfile } from './hostStore';

export interface HostClientResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<HostClientResponse>;
type SocketFactory = (url: string, password: string, handlers: TransportHandlers) => TerminalSocket;

export type HostIdentity = { name: string; color: string };

export interface HostClient {
  profile: HostProfile;
  baseUrl: string;
  authHeader: Record<string, string>;
  url(path: string): string;
  get(path: string, init?: RequestInit): Promise<HostClientResponse>;
  post(path: string, init?: RequestInit): Promise<HostClientResponse>;
  openSocket(
    path: string,
    params: Record<string, string | number>,
    handlers?: TransportHandlers,
  ): TerminalSocket;
  loadIdentity(): Promise<HostIdentity>;
}

function requestHeaders(password: string, headers?: HeadersInit): Headers {
  const merged = new Headers(headers);
  merged.set('Authorization', `Bearer ${password}`);
  return merged;
}

export function createHostClient(
  profile: HostProfile,
  password: string,
  dependencies: { fetch?: FetchLike; openSocket?: SocketFactory } = {},
): HostClient {
  const baseUrl = httpBase(profile.host, profile.port);
  const request = (path: string, init: RequestInit = {}) =>
    (dependencies.fetch ?? (fetch as unknown as FetchLike))(`${baseUrl}${path}`, {
      ...init,
      headers: requestHeaders(password, init.headers),
    });
  const socket = dependencies.openSocket ?? openTerminalSocket;

  return {
    profile,
    baseUrl,
    authHeader: { Authorization: `Bearer ${password}` },
    url: (path) => `${baseUrl}${path}`,
    get: request,
    post: (path, init = {}) => request(path, { ...init, method: init.method ?? 'POST' }),
    openSocket: (
      path,
      params,
      handlers = { onOpen: () => {}, onMessage: () => {}, onClose: () => {} },
    ) =>
      socket(
        wsUrl(profile.host, profile.port, params).replace('/api/ws', path),
        password,
        handlers,
      ),
    async loadIdentity() {
      const response = await request('/api/config');
      if (!response.ok) throw new Error(`Could not load host identity (${response.status})`);
      const config = (await response.json()) as { identity?: unknown };
      const identity = config.identity;
      if (
        typeof identity !== 'object' ||
        identity === null ||
        typeof (identity as { name?: unknown }).name !== 'string' ||
        typeof (identity as { color?: unknown }).color !== 'string'
      ) {
        throw new Error('Host configuration has no valid identity');
      }
      return identity as HostIdentity;
    },
  };
}
