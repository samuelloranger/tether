import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notify } from '../dialog';
import { getPassword, setPassword as persistPassword } from '../secureConfig';
import {
  createDefaultHostStore,
  KEY_ACTIVE_HOST,
  mergeSavedProfile,
  persistHostConfig,
  profileForForm,
  type TestStatus,
  testServerConnection,
} from './connectionConfigLogic';
import { createHostClient } from './hostClient';
import type { HostProfile, HostStore } from './hostStore';

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
  const hostStoreRef = useRef(hostStore ?? createDefaultHostStore());
  const lastConnectedRef = useRef({ ip: '', port: '8085' });

  const formProfile = useMemo(
    () => profileForForm({ profiles, editingHostId, activeHostId, serverIp, port }),
    [activeHostId, editingHostId, port, profiles, serverIp],
  );
  const client = useMemo(() => createHostClient(formProfile, password), [formProfile, password]);
  const clientFor = useCallback(
    (profile: HostProfile) => createHostClient(profile, passwordsRef.current.get(profile.id) ?? ''),
    [],
  );

  const applyProfile = useCallback(async (profile: HostProfile) => {
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
      await applyProfile(current);
    } catch {
      setProfiles(null);
      setStoreError('Hosts could not be loaded. Check device storage and retry.');
      setReady(false);
      setIsConfiguring(true);
    }
  }, [applyProfile]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);
  useEffect(() => {
    passwordRef.current = password;
  }, [password]);

  const activateHost = useCallback(
    async (hostId: string) => {
      const profile = profiles?.find((candidate) => candidate.id === hostId);
      if (profile) await applyProfile(profile);
    },
    [applyProfile, profiles],
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
    setTestStatus({ kind: 'testing' });
    const result = await testServerConnection({
      client,
      serverIp,
      port,
      password,
      confirmPassword,
    });
    if (result.setupMode) setSetupMode(result.setupMode);
    if (!result.ok) {
      setTestStatus({ kind: 'error', msg: result.msg });
      return;
    }
    setDiscoveredIdentity(result.identity);
    setTestStatus({ kind: 'ok' });
  };

  const saveConfig = async () => {
    try {
      const wasReady = readyRef.current;
      const next = await persistHostConfig({
        hostStore: hostStoreRef.current,
        editingHostId,
        serverIp,
        port,
        password,
        identity: discoveredIdentity,
      });
      await persistPassword(next.id, password);
      passwordsRef.current.set(next.id, password);
      setProfiles((previous) => mergeSavedProfile(previous, next));
      const addressChanged =
        next.id === activeHostId &&
        (serverIp !== lastConnectedRef.current.ip || port !== lastConnectedRef.current.port);
      await applyProfile(next);
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
          if (next[0]) await applyProfile(next[0]);
          else openAddHost();
        }
      } catch {
        setStoreError('Host changes could not be saved. Retry from Hosts.');
      }
    },
    [activeHostId, applyProfile, openAddHost, profiles],
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
