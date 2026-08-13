import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDefaultHostStore, profileForForm, type TestStatus } from './connectionConfigLogic';
import {
  applyHostProfile,
  type ConnectionMutators,
  loadHostProfiles,
  openAddHostForm,
  openEditHostForm,
  patchHostProfile,
  refreshHostIdentity,
  removeHostAndActivate,
  replaceHostPassword,
  runTestConnection,
  saveHostConfig,
  saveHostIdentity,
} from './connectionConfigOps';
import { createHostClient } from './hostClient';
import type { HostProfile, HostStore } from './hostStore';

function bindMutators(
  refs: Pick<
    ConnectionMutators,
    'passwordsRef' | 'passwordRef' | 'readyRef' | 'lastConnectedRef' | 'hostStoreRef'
  >,
  setters: Omit<
    ConnectionMutators,
    'passwordsRef' | 'passwordRef' | 'readyRef' | 'lastConnectedRef' | 'hostStoreRef'
  >,
): ConnectionMutators {
  return { ...refs, ...setters };
}

function useConnectionForm(hostStore?: HostStore) {
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
  const mutators = bindMutators(
    { passwordsRef, passwordRef, readyRef, lastConnectedRef, hostStoreRef },
    {
      setActiveHostId,
      setEditingHostId,
      setServerIp,
      setPort,
      setPassword,
      setConfirmPassword,
      setSetupMode,
      setTestStatus,
      setDiscoveredIdentity,
      setIsConfiguring,
      setReady,
      setProfiles,
      setStoreError,
    },
  );
  const mut = useRef(mutators);
  mut.current = mutators;
  return {
    serverIp,
    port,
    password,
    passwordRef,
    setupMode,
    confirmPassword,
    testStatus,
    isConfiguring,
    ready,
    activeHostId,
    editingHostId,
    profiles,
    storeError,
    discoveredIdentity,
    lastConnectedRef,
    mut,
  };
}

function persistOps(
  f: ReturnType<typeof useConnectionForm>,
  client: ReturnType<typeof createHostClient>,
  clientFor: (profile: HostProfile) => ReturnType<typeof createHostClient>,
  applyProfile: (profile: HostProfile) => Promise<void>,
  openAddHost: () => void,
  updateProfile: (
    hostId: string,
    changes: Partial<Omit<HostProfile, 'id' | 'order'>>,
  ) => Promise<void>,
) {
  return {
    testConnection: () =>
      runTestConnection({
        s: f.mut.current,
        client,
        serverIp: f.serverIp,
        port: f.port,
        password: f.password,
        confirmPassword: f.confirmPassword,
      }),
    saveConfig: () =>
      saveHostConfig({
        s: f.mut.current,
        editingHostId: f.editingHostId,
        activeHostId: f.activeHostId,
        serverIp: f.serverIp,
        port: f.port,
        password: f.password,
        discoveredIdentity: f.discoveredIdentity,
        applyProfile,
      }),
    removeHost: (hostId: string) =>
      removeHostAndActivate({
        s: f.mut.current,
        hostId,
        activeHostId: f.activeHostId,
        profiles: f.profiles,
        applyProfile,
        openAddHost,
      }),
    reorderHosts: async (ids: string[]) => {
      try {
        f.mut.current.setProfiles(await f.mut.current.hostStoreRef.current.reorder(ids));
      } catch {
        f.mut.current.setStoreError('Host changes could not be saved. Retry from Hosts.');
      }
    },
    replaceStoredPassword: (hostId: string, nextPassword: string) =>
      replaceHostPassword(f.mut.current, hostId, nextPassword, f.activeHostId),
    updateIdentity: (hostId: string, identity: { name: string; color: string }) =>
      saveHostIdentity(updateProfile, f.profiles, hostId, identity),
    refreshIdentity: (profile: HostProfile) =>
      refreshHostIdentity(clientFor, updateProfile, profile),
  };
}

function useConnectionOps(
  f: ReturnType<typeof useConnectionForm>,
  client: ReturnType<typeof createHostClient>,
  clientFor: (profile: HostProfile) => ReturnType<typeof createHostClient>,
) {
  const applyProfile = useCallback(
    (profile: HostProfile) => applyHostProfile(f.mut.current, profile),
    [f.mut],
  );
  const loadProfiles = useCallback(
    () => loadHostProfiles(f.mut.current, applyProfile),
    [applyProfile, f.mut],
  );
  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);
  useEffect(() => {
    f.passwordRef.current = f.password;
  }, [f.password, f.passwordRef]);
  const activateHost = useCallback(
    async (hostId: string) => {
      const profile = f.profiles?.find((candidate) => candidate.id === hostId);
      if (profile) await applyProfile(profile);
    },
    [applyProfile, f.profiles],
  );
  const openAddHost = useCallback(() => openAddHostForm(f.mut.current), [f.mut]);
  const openEditHost = useCallback(
    (hostId: string) => openEditHostForm(f.mut.current, f.profiles, hostId),
    [f.mut, f.profiles],
  );
  const updateProfile = useCallback(
    (hostId: string, changes: Partial<Omit<HostProfile, 'id' | 'order'>>) =>
      patchHostProfile(f.mut.current, hostId, changes),
    [f.mut],
  );
  return {
    applyProfile,
    loadProfiles,
    activateHost,
    openAddHost,
    openEditHost,
    updateProfile,
    ...persistOps(f, client, clientFor, applyProfile, openAddHost, updateProfile),
  };
}

export function useConnectionConfig({ hostStore }: { hostStore?: HostStore } = {}) {
  const f = useConnectionForm(hostStore);
  const formProfile = useMemo(
    () =>
      profileForForm({
        profiles: f.profiles,
        editingHostId: f.editingHostId,
        activeHostId: f.activeHostId,
        serverIp: f.serverIp,
        port: f.port,
      }),
    [f.activeHostId, f.editingHostId, f.port, f.profiles, f.serverIp],
  );
  const client = useMemo(
    () => createHostClient(formProfile, f.password),
    [formProfile, f.password],
  );
  const clientFor = useCallback(
    (profile: HostProfile) =>
      createHostClient(profile, f.mut.current.passwordsRef.current.get(profile.id) ?? ''),
    [f.mut],
  );
  const ops = useConnectionOps(f, client, clientFor);
  const m = f.mut.current;
  return {
    serverIp: f.serverIp,
    setServerIp: m.setServerIp,
    port: f.port,
    setPort: m.setPort,
    password: f.password,
    setPassword: m.setPassword,
    passwordRef: f.passwordRef,
    setupMode: f.setupMode,
    setSetupMode: m.setSetupMode,
    confirmPassword: f.confirmPassword,
    setConfirmPassword: m.setConfirmPassword,
    testStatus: f.testStatus,
    setTestStatus: m.setTestStatus,
    isConfiguring: f.isConfiguring,
    setIsConfiguring: m.setIsConfiguring,
    ready: f.ready,
    activeHostId: f.activeHostId,
    profiles: f.profiles,
    storeError: f.storeError,
    client,
    clientFor,
    lastConnectedRef: f.lastConnectedRef,
    ...ops,
  };
}
