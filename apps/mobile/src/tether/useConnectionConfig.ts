import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateAddress } from '../address';
import { notify } from '../dialog';
import {
  clearLegacyPassword,
  clearPassword,
  getLegacyPassword,
  getPassword,
  setPassword as persistPassword,
} from '../secureConfig';
import { createHostClient } from './hostClient';
import { createHostStore, type HostProfile, type HostStore } from './hostStore';

const KEY_ACTIVE_HOST = 'tether_active_host';
type TestStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; msg: string };

export function useConnectionConfig({ hostStore }: { hostStore?: HostStore } = {}) {
  const [serverIp, setServerIp] = useState('');
  const [port, setPort] = useState('8085');
  const [password, setPassword] = useState('');
  const passwordRef = useRef('');
  const passwordsRef = useRef(new Map<string, string>());
  const [setupMode, setSetupMode] = useState<'unknown' | 'create' | 'enter'>('unknown');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' });
  const [isConfiguring, setIsConfiguring] = useState(true);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<HostProfile[] | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [discoveredIdentity, setDiscoveredIdentity] = useState<{
    name: string;
    color: string;
  } | null>(null);
  const hostStoreRef = useRef(
    hostStore ??
      createHostStore({
        storage: AsyncStorage,
        secrets: {
          get: getPassword,
          set: persistPassword,
          clear: clearPassword,
          getLegacy: getLegacyPassword,
          clearLegacy: clearLegacyPassword,
        },
      }),
  );
  const lastConnectedRef = useRef({ ip: '', port: '8085' });

  const profileForForm = useMemo<HostProfile>(() => {
    const existing = profiles?.find(
      (profile) => profile.id === editingHostId || profile.id === activeHostId,
    );
    return existing
      ? { ...existing, host: serverIp, port }
      : {
          id: editingHostId ?? activeHostId ?? 'pending',
          name: serverIp,
          color: '#89b4fa',
          host: serverIp,
          port,
          identityName: '',
          order: profiles?.length ?? 0,
        };
  }, [activeHostId, editingHostId, port, profiles, serverIp]);
  const client = useMemo(
    () => createHostClient(profileForForm, password),
    [password, profileForForm],
  );
  const clientFor = useCallback(
    (profile: HostProfile) => createHostClient(profile, passwordsRef.current.get(profile.id) ?? ''),
    [],
  );

  const loadProfiles = useCallback(async () => {
    setStoreError(null);
    try {
      const next = await hostStoreRef.current.list();
      const storedActive = await AsyncStorage.getItem(KEY_ACTIVE_HOST).catch(() => null);
      const current = next.find((profile) => profile.id === storedActive) ?? next[0] ?? null;
      const credentials = await Promise.all(
        next.map(async (profile) => [profile.id, await getPassword(profile.id)] as const),
      );
      passwordsRef.current = new Map(
        credentials.flatMap(([id, value]) => (value === null ? [] : [[id, value]])),
      );
      setProfiles(next);
      if (!current) {
        setActiveHostId(null);
        setEditingHostId(null);
        setReady(false);
        setIsConfiguring(true);
        return;
      }
      const currentPassword = passwordsRef.current.get(current.id) ?? '';
      setActiveHostId(current.id);
      setEditingHostId(current.id);
      setServerIp(current.host);
      setPort(current.port);
      setPassword(currentPassword);
      passwordRef.current = currentPassword;
      lastConnectedRef.current = { ip: current.host, port: current.port };
      void AsyncStorage.setItem(KEY_ACTIVE_HOST, current.id).catch(() => {});
      readyRef.current = true;
      setReady(true);
      setIsConfiguring(false);
    } catch {
      setProfiles(null);
      setStoreError('Hosts could not be loaded. Check device storage and retry.');
      setReady(false);
      setIsConfiguring(true);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);
  useEffect(() => {
    passwordRef.current = password;
  }, [password]);

  const activateProfile = useCallback(async (profile: HostProfile) => {
    const hostPassword =
      passwordsRef.current.get(profile.id) ?? (await getPassword(profile.id)) ?? '';
    passwordsRef.current.set(profile.id, hostPassword);
    setActiveHostId(profile.id);
    setEditingHostId(profile.id);
    setServerIp(profile.host);
    setPort(profile.port);
    setPassword(hostPassword);
    passwordRef.current = hostPassword;
    lastConnectedRef.current = { ip: profile.host, port: profile.port };
    await AsyncStorage.setItem(KEY_ACTIVE_HOST, profile.id).catch(() => {});
    readyRef.current = true;
    setReady(true);
    setIsConfiguring(false);
  }, []);
  const activateHost = useCallback(
    async (hostId: string) => {
      const profile = profiles?.find((candidate) => candidate.id === hostId);
      if (!profile) return;
      await activateProfile(profile);
    },
    [activateProfile, profiles],
  );

  const openAddHost = useCallback(() => {
    setEditingHostId(null);
    setServerIp('');
    setPort('8085');
    setPassword('');
    setConfirmPassword('');
    setSetupMode('unknown');
    setTestStatus({ kind: 'idle' });
    setDiscoveredIdentity(null);
    setIsConfiguring(true);
  }, []);
  const openEditHost = useCallback(
    async (hostId: string) => {
      const profile = profiles?.find((candidate) => candidate.id === hostId);
      if (!profile) return;
      setEditingHostId(hostId);
      setServerIp(profile.host);
      setPort(profile.port);
      const hostPassword = passwordsRef.current.get(hostId) ?? (await getPassword(hostId)) ?? '';
      setPassword(hostPassword);
      passwordRef.current = hostPassword;
      setConfirmPassword('');
      setTestStatus({ kind: 'idle' });
      setIsConfiguring(true);
    },
    [profiles],
  );

  const testConnection = async () => {
    const address = validateAddress(serverIp, port);
    if (!address.ok) return setTestStatus({ kind: 'error', msg: address.reason });
    setTestStatus({ kind: 'testing' });
    try {
      const status = await client.get('/api/status', { signal: AbortSignal.timeout(5000) });
      if (!status.ok) throw new Error('Server is unavailable.');
      const needsSetup = Boolean(((await status.json()) as { needsSetup?: unknown }).needsSetup);
      setSetupMode(needsSetup ? 'create' : 'enter');
      if (!password)
        throw new Error(
          needsSetup ? 'Choose a password for this server.' : 'Enter the server password.',
        );
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
      setDiscoveredIdentity(await client.loadIdentity().catch(() => null));
      setTestStatus({ kind: 'ok' });
    } catch (error) {
      setTestStatus({
        kind: 'error',
        msg: error instanceof Error ? error.message : 'Unreachable — check the host and port.',
      });
    }
  };

  const saveConfig = async () => {
    try {
      const wasReady = readyRef.current;
      const identity = discoveredIdentity;
      let hostId = editingHostId;
      let next: HostProfile;
      if (hostId) {
        next = await hostStoreRef.current.update(hostId, {
          host: serverIp,
          port,
          ...(identity
            ? { name: identity.name, color: identity.color, identityName: identity.name }
            : {}),
        });
      } else {
        next = await hostStoreRef.current.create({
          name: identity?.name ?? serverIp,
          color: identity?.color ?? '#89b4fa',
          host: serverIp,
          port,
          identityName: identity?.name ?? '',
        });
        hostId = next.id;
      }
      await persistPassword(hostId, password);
      passwordsRef.current.set(hostId, password);
      setProfiles((previous) => {
        const current = previous ?? [];
        return [...current.filter((profile) => profile.id !== next.id), next].sort(
          (left, right) => left.order - right.order,
        );
      });
      const addressChanged =
        hostId === activeHostId &&
        (serverIp !== lastConnectedRef.current.ip || port !== lastConnectedRef.current.port);
      await activateProfile(next);
      return { addressChanged, wasReady };
    } catch {
      void notify('Error', 'Failed to save host configuration', 'error');
      return { addressChanged: false, wasReady: readyRef.current };
    }
  };

  const removeHost = useCallback(
    async (hostId: string) => {
      try {
        await hostStoreRef.current.remove(hostId);
        passwordsRef.current.delete(hostId);
        const next = (profiles ?? [])
          .filter((profile) => profile.id !== hostId)
          .map((profile, order) => ({ ...profile, order }));
        setProfiles(next);
        if (hostId === activeHostId) {
          if (next[0]) await activateProfile(next[0]);
          else openAddHost();
        }
      } catch {
        setStoreError('Host changes could not be saved. Retry from Hosts.');
      }
    },
    [activeHostId, activateProfile, openAddHost, profiles],
  );

  const updateProfile = useCallback(
    async (hostId: string, changes: Partial<Omit<HostProfile, 'id' | 'order'>>) => {
      try {
        const next = await hostStoreRef.current.update(hostId, changes);
        setProfiles((previous) =>
          (previous ?? []).map((profile) => (profile.id === hostId ? next : profile)),
        );
      } catch {
        setStoreError('Host changes could not be saved. Retry from Hosts.');
      }
    },
    [],
  );
  const reorderHosts = useCallback(async (ids: string[]) => {
    try {
      setProfiles(await hostStoreRef.current.reorder(ids));
    } catch {
      setStoreError('Host changes could not be saved. Retry from Hosts.');
    }
  }, []);
  const replaceStoredPassword = useCallback(
    async (hostId: string, nextPassword: string) => {
      await persistPassword(hostId, nextPassword);
      passwordsRef.current.set(hostId, nextPassword);
      if (hostId === activeHostId) {
        setPassword(nextPassword);
        passwordRef.current = nextPassword;
      }
    },
    [activeHostId],
  );
  const updateIdentity = useCallback(
    async (hostId: string, identity: { name: string; color: string }) => {
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
    },
    [profiles, updateProfile],
  );
  const refreshIdentity = useCallback(
    async (profile: HostProfile) => {
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
    },
    [clientFor, updateProfile],
  );

  return {
    serverIp,
    setServerIp,
    port,
    setPort,
    password,
    setPassword,
    passwordRef,
    setupMode,
    setSetupMode,
    confirmPassword,
    setConfirmPassword,
    testStatus,
    setTestStatus,
    isConfiguring,
    setIsConfiguring,
    ready,
    activeHostId,
    profiles,
    storeError,
    client,
    clientFor,
    lastConnectedRef,
    testConnection,
    saveConfig,
    loadProfiles,
    activateHost,
    openAddHost,
    openEditHost,
    removeHost,
    updateProfile,
    reorderHosts,
    replaceStoredPassword,
    updateIdentity,
    refreshIdentity,
  };
}
