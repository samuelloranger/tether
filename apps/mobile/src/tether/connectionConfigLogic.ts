import AsyncStorage from '@react-native-async-storage/async-storage';
import { validateAddress } from '../address';
import {
  clearLegacyPassword,
  clearPassword,
  getLegacyPassword,
  getPassword,
  setPassword as persistPassword,
} from '../secureConfig';
import type { HostClientResponse } from './hostClient';
import { createHostStore, type HostProfile, type HostStore } from './hostStore';

export const KEY_ACTIVE_HOST = 'tether_active_host';

export type TestStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; msg: string };

export type DiscoveredIdentity = { name: string; color: string };

type StatusClient = {
  get(path: string, init?: { signal?: AbortSignal }): Promise<HostClientResponse>;
  post(
    path: string,
    init?: { headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<HostClientResponse>;
  loadIdentity(): Promise<DiscoveredIdentity>;
};

export function createDefaultHostStore(): HostStore {
  return createHostStore({
    storage: AsyncStorage,
    secrets: {
      get: getPassword,
      set: persistPassword,
      clear: clearPassword,
      getLegacy: getLegacyPassword,
      clearLegacy: clearLegacyPassword,
    },
  });
}

export function profileForForm(args: {
  profiles: HostProfile[] | null;
  editingHostId: string | null;
  activeHostId: string | null;
  serverIp: string;
  port: string;
}): HostProfile {
  const existing = args.profiles?.find(
    (profile) => profile.id === args.editingHostId || profile.id === args.activeHostId,
  );
  return existing
    ? { ...existing, host: args.serverIp, port: args.port }
    : {
        id: args.editingHostId ?? args.activeHostId ?? 'pending',
        name: args.serverIp,
        color: '#89b4fa',
        host: args.serverIp,
        port: args.port,
        identityName: '',
        order: args.profiles?.length ?? 0,
      };
}

export async function testServerConnection(args: {
  client: StatusClient;
  serverIp: string;
  port: string;
  password: string;
  confirmPassword: string;
}): Promise<
  | { ok: true; setupMode: 'create' | 'enter'; identity: DiscoveredIdentity | null }
  | { ok: false; msg: string; setupMode?: 'create' | 'enter' }
> {
  const address = validateAddress(args.serverIp, args.port);
  if (!address.ok) return { ok: false, msg: address.reason };
  let setupMode: 'create' | 'enter' | undefined;
  try {
    const status = await args.client.get('/api/status', { signal: AbortSignal.timeout(5000) });
    if (!status.ok) throw new Error('Server is unavailable.');
    const needsSetup = Boolean(((await status.json()) as { needsSetup?: unknown }).needsSetup);
    setupMode = needsSetup ? 'create' : 'enter';
    if (!args.password) {
      return {
        ok: false,
        setupMode,
        msg: needsSetup ? 'Choose a password for this server.' : 'Enter the server password.',
      };
    }
    if (needsSetup) {
      if (args.password !== args.confirmPassword) throw new Error('Passwords do not match.');
      const setup = await args.client.post('/api/setup', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: args.password }),
        signal: AbortSignal.timeout(5000),
      });
      if (setup.status === 409) throw new Error('Already set up. Enter the existing password.');
      if (!setup.ok) throw new Error('Setup failed — try again.');
    } else {
      const health = await args.client.get('/api/health', { signal: AbortSignal.timeout(5000) });
      if (health.status === 401) throw new Error('Wrong password.');
      if (!health.ok) throw new Error(`Server error (${health.status}).`);
    }
    return {
      ok: true,
      setupMode,
      identity: await args.client.loadIdentity().catch(() => null),
    };
  } catch (error) {
    return {
      ok: false,
      setupMode,
      msg: error instanceof Error ? error.message : 'Unreachable — check the host and port.',
    };
  }
}

export async function persistHostConfig(args: {
  hostStore: HostStore;
  editingHostId: string | null;
  serverIp: string;
  port: string;
  password: string;
  identity: DiscoveredIdentity | null;
}): Promise<HostProfile> {
  if (args.editingHostId) {
    return args.hostStore.update(args.editingHostId, {
      host: args.serverIp,
      port: args.port,
      ...(args.identity
        ? {
            name: args.identity.name,
            color: args.identity.color,
            identityName: args.identity.name,
          }
        : {}),
    });
  }
  return args.hostStore.create({
    name: args.identity?.name ?? args.serverIp,
    color: args.identity?.color ?? '#89b4fa',
    host: args.serverIp,
    port: args.port,
    identityName: args.identity?.name ?? '',
  });
}

export function mergeSavedProfile(
  previous: HostProfile[] | null,
  next: HostProfile,
): HostProfile[] {
  const current = previous ?? [];
  return [...current.filter((profile) => profile.id !== next.id), next].sort(
    (left, right) => left.order - right.order,
  );
}
