import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MutableRefObject } from 'react';
import { validateAddress } from '../address';
import { notify } from '../dialog';
import { getPassword, setPassword as persistPassword } from '../secureConfig';
import {
  KEY_ACTIVE_HOST,
  mergeSavedProfile,
  persistHostConfig,
  type TestStatus,
  testServerConnection,
} from './connectionConfigLogic';
import type { HostClient } from './hostClient';
import type { HostProfile, HostStore } from './hostStore';

export type ConnectionMutators = {
  passwordsRef: MutableRefObject<Map<string, string>>;
  passwordRef: MutableRefObject<string>;
  readyRef: MutableRefObject<boolean>;
  lastConnectedRef: MutableRefObject<{ ip: string; port: string }>;
  hostStoreRef: MutableRefObject<HostStore>;
  setActiveHostId: (id: string | null) => void;
  setEditingHostId: (id: string | null) => void;
  setServerIp: (ip: string) => void;
  setPort: (port: string) => void;
  setPassword: (password: string) => void;
  setConfirmPassword: (password: string) => void;
  setSetupMode: (mode: 'unknown' | 'create' | 'enter') => void;
  setTestStatus: (status: TestStatus) => void;
  setDiscoveredIdentity: (identity: { name: string; color: string } | null) => void;
  setIsConfiguring: (value: boolean) => void;
  setReady: (value: boolean) => void;
  setProfiles: (
    value: HostProfile[] | null | ((previous: HostProfile[] | null) => HostProfile[] | null),
  ) => void;
  setStoreError: (error: string | null) => void;
};

export async function runTestConnection(args: {
  s: ConnectionMutators;
  client: Parameters<typeof testServerConnection>[0]['client'];
  serverIp: string;
  port: string;
  password: string;
  confirmPassword: string;
}): Promise<void> {
  // Validate synchronously so a malformed host/port never flashes "Testing…".
  const address = validateAddress(args.serverIp, args.port);
  if (!address.ok) {
    args.s.setTestStatus({ kind: 'error', msg: address.reason });
    return;
  }
  args.s.setTestStatus({ kind: 'testing' });
  const result = await testServerConnection({
    client: args.client,
    serverIp: args.serverIp,
    port: args.port,
    password: args.password,
    confirmPassword: args.confirmPassword,
  });
  if (result.setupMode) args.s.setSetupMode(result.setupMode);
  if (!result.ok) {
    args.s.setTestStatus({ kind: 'error', msg: result.msg });
    return;
  }
  args.s.setDiscoveredIdentity(result.identity);
  args.s.setTestStatus({ kind: 'ok' });
}

export async function applyHostProfile(s: ConnectionMutators, profile: HostProfile): Promise<void> {
  const hostPassword =
    s.passwordsRef.current.get(profile.id) ?? (await getPassword(profile.id)) ?? '';
  s.passwordsRef.current.set(profile.id, hostPassword);
  s.setActiveHostId(profile.id);
  s.setEditingHostId(profile.id);
  s.setServerIp(profile.host);
  s.setPort(profile.port);
  s.setPassword(hostPassword);
  s.passwordRef.current = hostPassword;
  s.lastConnectedRef.current = { ip: profile.host, port: profile.port };
  await AsyncStorage.setItem(KEY_ACTIVE_HOST, profile.id).catch(() => {});
  s.readyRef.current = true;
  s.setReady(true);
  s.setIsConfiguring(false);
}

export async function loadHostProfiles(
  s: ConnectionMutators,
  applyProfile: (profile: HostProfile) => Promise<void>,
): Promise<void> {
  s.setStoreError(null);
  try {
    const next = await s.hostStoreRef.current.list();
    const storedActive = await AsyncStorage.getItem(KEY_ACTIVE_HOST).catch(() => null);
    const current = next.find((profile) => profile.id === storedActive) ?? next[0] ?? null;
    const credentials = await Promise.all(
      next.map(async (profile) => [profile.id, await getPassword(profile.id)] as const),
    );
    s.passwordsRef.current = new Map(
      credentials.flatMap(([id, value]) => (value === null ? [] : [[id, value]])),
    );
    s.setProfiles(next);
    if (!current) {
      s.setActiveHostId(null);
      s.setEditingHostId(null);
      s.setReady(false);
      s.setIsConfiguring(true);
      return;
    }
    await applyProfile(current);
  } catch {
    s.setProfiles(null);
    s.setStoreError('Hosts could not be loaded. Check device storage and retry.');
    s.setReady(false);
    s.setIsConfiguring(true);
  }
}

export function openAddHostForm(s: ConnectionMutators): void {
  s.setEditingHostId(null);
  s.setServerIp('');
  s.setPort('8085');
  s.setPassword('');
  s.setConfirmPassword('');
  s.setSetupMode('unknown');
  s.setTestStatus({ kind: 'idle' });
  s.setDiscoveredIdentity(null);
  s.setIsConfiguring(true);
}

export async function openEditHostForm(
  s: ConnectionMutators,
  profiles: HostProfile[] | null,
  hostId: string,
): Promise<void> {
  const profile = profiles?.find((candidate) => candidate.id === hostId);
  if (!profile) return;
  s.setEditingHostId(hostId);
  s.setServerIp(profile.host);
  s.setPort(profile.port);
  const hostPassword = s.passwordsRef.current.get(hostId) ?? (await getPassword(hostId)) ?? '';
  s.setPassword(hostPassword);
  s.passwordRef.current = hostPassword;
  s.setConfirmPassword('');
  s.setTestStatus({ kind: 'idle' });
  s.setIsConfiguring(true);
}

export async function saveHostConfig(args: {
  s: ConnectionMutators;
  editingHostId: string | null;
  activeHostId: string | null;
  serverIp: string;
  port: string;
  password: string;
  discoveredIdentity: { name: string; color: string } | null;
  applyProfile: (profile: HostProfile) => Promise<void>;
}): Promise<{ addressChanged: boolean; wasReady: boolean }> {
  try {
    const wasReady = args.s.readyRef.current;
    const next = await persistHostConfig({
      hostStore: args.s.hostStoreRef.current,
      editingHostId: args.editingHostId,
      serverIp: args.serverIp,
      port: args.port,
      password: args.password,
      identity: args.discoveredIdentity,
    });
    await persistPassword(next.id, args.password);
    args.s.passwordsRef.current.set(next.id, args.password);
    args.s.setProfiles((previous) => mergeSavedProfile(previous, next));
    const addressChanged =
      next.id === args.activeHostId &&
      (args.serverIp !== args.s.lastConnectedRef.current.ip ||
        args.port !== args.s.lastConnectedRef.current.port);
    await args.applyProfile(next);
    return { addressChanged, wasReady };
  } catch {
    void notify('Error', 'Failed to save host configuration', 'error');
    return { addressChanged: false, wasReady: args.s.readyRef.current };
  }
}

export async function removeHostAndActivate(args: {
  s: ConnectionMutators;
  hostId: string;
  activeHostId: string | null;
  profiles: HostProfile[] | null;
  applyProfile: (profile: HostProfile) => Promise<void>;
  openAddHost: () => void;
}): Promise<void> {
  try {
    await args.s.hostStoreRef.current.remove(args.hostId);
    args.s.passwordsRef.current.delete(args.hostId);
    const next = (args.profiles ?? [])
      .filter((profile) => profile.id !== args.hostId)
      .map((profile, order) => ({ ...profile, order }));
    args.s.setProfiles(next);
    if (args.hostId === args.activeHostId) {
      if (next[0]) await args.applyProfile(next[0]);
      else args.openAddHost();
    }
  } catch {
    args.s.setStoreError('Host changes could not be saved. Retry from Hosts.');
  }
}

export async function patchHostProfile(
  s: ConnectionMutators,
  hostId: string,
  changes: Partial<Omit<HostProfile, 'id' | 'order'>>,
): Promise<void> {
  try {
    const next = await s.hostStoreRef.current.update(hostId, changes);
    s.setProfiles((previous) =>
      (previous ?? []).map((profile) => (profile.id === hostId ? next : profile)),
    );
  } catch {
    s.setStoreError('Host changes could not be saved. Retry from Hosts.');
  }
}

export async function replaceHostPassword(
  s: ConnectionMutators,
  hostId: string,
  nextPassword: string,
  activeHostId: string | null,
): Promise<void> {
  await persistPassword(hostId, nextPassword);
  s.passwordsRef.current.set(hostId, nextPassword);
  if (hostId === activeHostId) {
    s.setPassword(nextPassword);
    s.passwordRef.current = nextPassword;
  }
}

export async function saveHostIdentity(
  updateProfile: (
    hostId: string,
    changes: Partial<Omit<HostProfile, 'id' | 'order'>>,
  ) => Promise<void>,
  profiles: HostProfile[] | null,
  hostId: string,
  identity: { name: string; color: string },
): Promise<void> {
  const profile = profiles?.find((candidate) => candidate.id === hostId);
  if (!profile) return;
  // One name per machine. Whatever is saved here becomes the profile name
  // and the identity the server reports, so the page cannot show one name
  // in its header and a different one in its Name field.
  await updateProfile(hostId, {
    name: identity.name,
    identityName: identity.name,
    color: identity.color,
  });
}

export async function refreshHostIdentity(
  clientFor: (profile: HostProfile) => HostClient,
  updateProfile: (
    hostId: string,
    changes: Partial<Omit<HostProfile, 'id' | 'order'>>,
  ) => Promise<void>,
  profile: HostProfile,
): Promise<void> {
  try {
    const identity = await clientFor(profile).loadIdentity();
    if (profile.identityName === identity.name) return;
    // Record what the server calls itself (deep links match on it) without
    // overwriting a name the user chose. Only an unnamed host adopts it.
    await updateProfile(profile.id, {
      identityName: identity.name,
      ...(profile.name === profile.host ? { name: identity.name } : {}),
    });
  } catch {
    // A dead or malformed host must not affect its neighbours' poll cycle.
  }
}
