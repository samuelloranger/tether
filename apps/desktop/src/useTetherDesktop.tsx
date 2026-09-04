// biome-ignore-all lint/style/noExcessiveLinesPerFile: desktop app state hook — owns hosts, sessions, pairing, and the screen state machine in one place
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  coreCacheDelete,
  coreHostRetry,
  coreHostsList,
  coreHostsMigrate,
  coreHostsRemove,
  coreHostsSave,
  coreHostsSaveNoise,
  coreHostsUpdateConnection,
  coreHostsUpdateIdentity,
  coreNextTermId,
  coreNoiseDeviceFingerprint,
  coreNoisePair,
  coreNoisePing,
  coreNotifyWaitingEdge,
  corePollingRestart,
  corePollingSetActive,
  corePollingStart,
  corePollingStop,
  coreSessionsKill,
  coreSessionsList,
  coreSessionsRename,
  listenHostHealth,
  listenSessions,
} from './coreApi';
import type { FrameApplyResult } from './frameHandler';
import { isNoiseHost, markNoiseHost, noiseSessionAddress, unmarkNoiseHost } from './noiseHosts';
import { hostSecrets } from './secureConfig';
import { sessionKey } from './sessionKey';
import { sessionLabel } from './sessionLabel';
import { pickResume, restorableIds } from './sessionResume';
import {
  activeSessionStorageKey,
  type DrawerSession,
  HOST_PROFILES_KEY,
  type HostHealthStatus,
  type HostProfile,
  KEY_ACTIVE_HOST,
} from './types';

export type { DrawerSession } from './types';

type Screen =
  | 'main'
  | 'hosts'
  | 'host-form'
  | 'pair-device'
  | 'settings'
  | 'local-settings'
  | 'devices';

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: desktop app state hook mirrors mobile session runtime scope
export function useTetherDesktop() {
  const [ready, setReady] = useState(false);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<DrawerSession[]>([]);
  const [healthByHost, setHealthByHost] = useState<Record<string, HostHealthStatus>>({});
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  // '' means "no terminal open". It used to default to 'term-1', which the WS
  // open path turns into `startSession` — so a launch with nothing remembered
  // spawned a shell nobody asked for.
  const [activeSessionId, setActiveSessionId] = useState('');
  const [screen, setScreen] = useState<Screen>('main');
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitMode, setGitMode] = useState<'drawer' | 'review'>('drawer');
  const [settingsHostId, setSettingsHostId] = useState<string | null>(null);

  const activeHostIdRef = useRef<string | null>(null);
  const hostsRef = useRef<HostProfile[]>([]);
  const sessionsRef = useRef<DrawerSession[]>([]);
  const activeSessionIdRef = useRef(activeSessionId);

  activeHostIdRef.current = activeHostId;
  hostsRef.current = hosts;
  sessionsRef.current = sessions;
  activeSessionIdRef.current = activeSessionId;

  /**
   * Open the terminal the user was last in on this host — but only if it is
   * still running.
   *
   * The list is fetched rather than read off the poll because the poll may not
   * have reached this host yet, and opening a socket for a stopped id calls
   * `startSession` server-side, resurrecting a shell the user killed. A choice
   * made while the fetch is in flight wins over the restore.
   */
  const restoreSession = useCallback(async (hostId: string) => {
    const remembered = localStorage.getItem(activeSessionStorageKey(hostId));
    let rows = sessionsRef.current.filter((row) => row.hostId === hostId);
    try {
      rows = await coreSessionsList(hostId);
    } catch {
      // the poll's copy stands in
    }
    if (activeHostIdRef.current !== hostId || activeSessionIdRef.current !== '') return;
    const picked = pickResume(remembered, restorableIds(rows, hostId));
    if (picked) setActiveSessionId(picked);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenHealth: (() => void) | undefined;
    let unlistenSessions: (() => void) | undefined;
    void (async () => {
      const legacy = localStorage.getItem(HOST_PROFILES_KEY);
      const listed = await coreHostsMigrate(legacy);
      if (legacy) localStorage.removeItem(HOST_PROFILES_KEY);
      const loaded: Record<string, string> = {};
      for (const profile of listed) {
        const password = await hostSecrets.get(profile.id);
        if (password) loaded[profile.id] = password;
      }
      if (cancelled) return;
      setHosts(listed);
      setPasswords(loaded);
      for (const profile of listed) {
        setHealthByHost((current) => ({ ...current, [profile.id]: 'unknown' }));
      }
      const savedHost = localStorage.getItem(KEY_ACTIVE_HOST);
      const initialHost =
        listed.find((profile) => profile.id === savedHost)?.id ?? listed[0]?.id ?? null;
      if (initialHost) {
        setActiveHostId(initialHost);
        // Eagerly, because restoreSession checks the refs to see whether its
        // answer is still wanted and state has not re-rendered yet.
        activeHostIdRef.current = initialHost;
        localStorage.setItem(KEY_ACTIVE_HOST, initialHost);
        await corePollingSetActive(initialHost);
        void restoreSession(initialHost);
      }
      unlistenHealth = await listenHostHealth((hostId, status) => {
        // A Noise host has no password, so the poll's `/api/status` probe always
        // 401s it — ignore that here; its health comes from the Noise ping below.
        if (isNoiseHost(hostId)) return;
        setHealthByHost((current) => ({ ...current, [hostId]: status }));
      });
      unlistenSessions = await listenSessions((hostId, rows) => {
        setSessions((previous) => [...previous.filter((row) => row.hostId !== hostId), ...rows]);
      });
      if (listed.length > 0) await corePollingStart();
      setReady(true);
    })();
    return () => {
      cancelled = true;
      unlistenHealth?.();
      unlistenSessions?.();
      void corePollingStop();
    };
  }, [restoreSession]);

  useEffect(() => {
    if (!ready) return;
    void corePollingSetActive(activeHostId);
  }, [ready, activeHostId]);

  // Health for Noise hosts: the password poll can't authenticate them, so probe
  // reachability over the Noise path (a reconnect handshake) instead. A success
  // means up + still authorized; a failure (host down, or this device revoked)
  // shows unreachable.
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    const pingAll = async () => {
      for (const host of hostsRef.current) {
        if (!isNoiseHost(host.id)) continue;
        let ok = false;
        try {
          ok = await coreNoisePing(host.id, noiseSessionAddress(host.host, host.port));
        } catch {
          ok = false;
        }
        if (cancelled) return;
        setHealthByHost((current) => ({
          ...current,
          [host.id]: ok ? 'reachable' : 'unreachable',
        }));
      }
    };
    void pingAll();
    const timer = setInterval(() => void pingAll(), 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ready]);

  const activeHost = hosts.find((host) => host.id === activeHostId) ?? null;
  const activePassword = activeHost ? (passwords[activeHost.id] ?? '') : '';

  const selectHost = useCallback(
    (hostId: string) => {
      setActiveHostId(hostId);
      localStorage.setItem(KEY_ACTIVE_HOST, hostId);
      setActiveSessionId('');
      activeHostIdRef.current = hostId;
      activeSessionIdRef.current = '';
      setScreen('main');
      void restoreSession(hostId);
    },
    [restoreSession],
  );

  const selectSession = useCallback((hostId: string, sessionId: string) => {
    setActiveHostId(hostId);
    setActiveSessionId(sessionId);
    // Eagerly: an in-flight restore reads these to decide whether its answer is
    // still wanted, and must not land on top of a choice the user just made.
    activeHostIdRef.current = hostId;
    activeSessionIdRef.current = sessionId;
    localStorage.setItem(KEY_ACTIVE_HOST, hostId);
    localStorage.setItem(activeSessionStorageKey(hostId), sessionId);
    setScreen('main');
  }, []);

  /**
   * Start a terminal on one named host.
   *
   * The id is allocated against that host's own list, fetched fresh: a host the
   * drawer has never polled has no rows here, so the next id would come out
   * `term-1` — and `/api/sessions/start` answers a known id with the EXISTING
   * session, so the button would silently attach to a running shell instead of
   * opening a new one. The poll's copy is the fallback when the fetch fails.
   */
  const newSession = useCallback(
    async (hostId: string): Promise<string | null> => {
      const from = { host: activeHostIdRef.current, session: activeSessionIdRef.current };
      let ids = sessionsRef.current.filter((row) => row.hostId === hostId).map((row) => row.id);
      try {
        ids = (await coreSessionsList(hostId)).map((row) => row.id);
      } catch {
        // the poll's copy stands in
      }
      const nextId = await coreNextTermId(ids);
      // A slow host must not take the screen from wherever the user went while
      // it was answering — the same trade the restore path makes.
      if (activeHostIdRef.current !== from.host || activeSessionIdRef.current !== from.session) {
        return null;
      }
      // Show the tab immediately — the drawer/tab strip render off `sessions`,
      // which otherwise only refreshes on the next poll, so the new terminal
      // opened in its pane before its own tab appeared. The poll reconciles.
      setSessions((previous) =>
        previous.some((row) => row.hostId === hostId && row.id === nextId)
          ? previous
          : [
              ...previous,
              {
                hostId,
                id: nextId,
                status: 'running',
                last_output_at: null,
              },
            ],
      );
      selectSession(hostId, nextId);
      return nextId;
    },
    [selectSession],
  );

  const killSessionById = useCallback(
    async (hostId: string, sessionId: string) => {
      try {
        const switchTo = await coreSessionsKill({
          hostId,
          sessionId,
          activeHostId: activeHostIdRef.current,
          activeSessionId: activeSessionIdRef.current,
          drawerSessions: sessionsRef.current.map((row) => ({
            hostId: row.hostId,
            id: row.id,
          })),
        });
        await coreCacheDelete(sessionKey(hostId, sessionId));
        if (switchTo !== null && switchTo !== undefined) {
          selectSession(hostId, switchTo);
        }
      } catch {
        // refresh either way
      }
      await corePollingRestart();
    },
    [selectSession],
  );

  const renameSessionById = useCallback(async (hostId: string, sessionId: string, name: string) => {
    await coreSessionsRename(hostId, sessionId, name);
    setSessions((previous) =>
      previous.map((row) =>
        row.hostId === hostId && row.id === sessionId ? { ...row, name: name || null } : row,
      ),
    );
  }, []);

  const retryHost = useCallback((hostId: string) => {
    void coreHostRetry(hostId);
  }, []);

  const saveHost = useCallback(
    async (input: {
      id?: string;
      name: string;
      host: string;
      port: string;
      password: string;
      confirmPassword?: string;
    }) => {
      const profile = await coreHostsSave(input);
      setPasswords((current) => ({ ...current, [profile.id]: input.password }));
      const listed = await coreHostsList();
      setHosts(listed);
      setActiveHostId(profile.id);
      localStorage.setItem(KEY_ACTIVE_HOST, profile.id);
      setScreen('main');
      setEditingHostId(null);
    },
    [],
  );

  /**
   * Pair a new host over Noise, then persist it.
   *
   * The profile is created FIRST so the pinned device + server keys land under
   * its real id — reconnect (`coreNoiseReconnect`) namespaces its keys by the
   * host profile id, so pairing under any other id would strand them. This
   * mirrors HostFormScreen's save path (`coreHostsSave` → refresh → activate),
   * minus the routing, so the pairing screen can show the fingerprint before it
   * navigates on.
   *
   * NOTE: `coreHostsSave` still runs a password connection test and stores a
   * password in the keyring — the password-TOFU auth and Noise pairing are
   * separate systems today. A Noise-only server with no password will reject
   * this create; a password-less save path is a backend follow-up. If pairing
   * itself fails after the profile exists, the orphan profile is removed.
   */
  const pairHost = useCallback(
    async (
      input: {
        name: string;
        host: string;
        port: string;
        address: string;
        code: string;
      },
      onProgress?: (progress: { deviceFingerprint: string }) => void,
    ): Promise<{ fingerprint: string }> => {
      // Password-less save: a Noise host has no password, so it must NOT go
      // through the password connection test in `coreHostsSave`.
      const profile = await coreHostsSaveNoise({
        name: input.name,
        host: input.host,
        port: input.port,
      });
      try {
        // Surface THIS device's fingerprint before the pair call blocks on the
        // host's confirm, so the pairing screen can show it to read aloud
        // (parity with iOS). The device key is keyed by the profile id.
        const deviceFingerprint = await coreNoiseDeviceFingerprint(profile.id);
        onProgress?.({ deviceFingerprint });
        const fingerprint = await coreNoisePair({
          hostId: profile.id,
          address: input.address,
          code: input.code,
        });
        // Mark it a Noise host so its terminal streams over the Noise channel.
        markNoiseHost(profile.id);
        setPasswords((current) => ({ ...current, [profile.id]: '' }));
        setHosts(await coreHostsList());
        setActiveHostId(profile.id);
        localStorage.setItem(KEY_ACTIVE_HOST, profile.id);
        return { fingerprint };
      } catch (error) {
        await coreHostsRemove(profile.id).catch(() => undefined);
        unmarkNoiseHost(profile.id);
        throw error;
      }
    },
    [],
  );

  const removeHost = useCallback(
    async (hostId: string) => {
      await coreHostsRemove(hostId);
      unmarkNoiseHost(hostId);
      setHosts(await coreHostsList());
      setPasswords((current) => {
        const next = { ...current };
        delete next[hostId];
        return next;
      });
      setSessions((current) => current.filter((row) => row.hostId !== hostId));
      setHealthByHost((current) => {
        const next = { ...current };
        delete next[hostId];
        return next;
      });
      if (activeHostId === hostId) {
        const remaining = hostsRef.current.filter((host) => host.id !== hostId);
        setActiveHostId(remaining[0]?.id ?? null);
      }
    },
    [activeHostId],
  );

  const updateHostIdentity = useCallback(
    async (hostId: string, identity: { name: string; color: string }) => {
      const profile = await coreHostsUpdateIdentity(hostId, identity);
      setHosts(await coreHostsList());
      return profile;
    },
    [],
  );

  const updateHostConnection = useCallback(
    async (
      hostId: string,
      changes: Pick<HostProfile, 'host' | 'port'>,
      replacementPassword?: string,
    ) => {
      await coreHostsUpdateConnection(hostId, {
        host: changes.host,
        port: changes.port,
        replacementPassword,
      });
      if (replacementPassword) {
        setPasswords((current) => ({ ...current, [hostId]: replacementPassword }));
        await hostSecrets.set(hostId, replacementPassword);
      }
      setHosts(await coreHostsList());
    },
    [],
  );

  const updateHostPassword = useCallback(async (hostId: string, password: string) => {
    await hostSecrets.set(hostId, password);
    setPasswords((current) => ({ ...current, [hostId]: password }));
  }, []);

  const handleWsFrame = useCallback(
    (hostId: string, sessionId: string, frame: FrameApplyResult) => {
      if (frame.kind === 'title' && frame.title !== undefined) {
        setSessions((previous) =>
          previous.map((row) =>
            row.hostId === hostId && row.id === sessionId
              ? { ...row, auto_title: frame.title ?? null }
              : row,
          ),
        );
      }
      if (frame.kind === 'activity' && frame.activity !== undefined) {
        const previous = sessionsRef.current.find(
          (row) => row.hostId === hostId && row.id === sessionId,
        );
        const isActive =
          activeHostIdRef.current === hostId && activeSessionIdRef.current === sessionId;
        void coreNotifyWaitingEdge(previous?.activity, frame.activity, isActive).then(
          async (should) => {
            if (!should) return;
            if (localStorage.getItem('tether_notifications_enabled') === 'false') return;
            const { sendOsNotification } = await import('./desktopNotifications');
            await sendOsNotification(
              previous ? sessionLabel(previous) : sessionId,
              'Needs your input',
            );
          },
        );
        setSessions((previous) =>
          previous.map((row) =>
            row.hostId === hostId && row.id === sessionId
              ? { ...row, activity: frame.activity ?? null }
              : row,
          ),
        );
      }
    },
    [],
  );

  const activeSessionLabel = useMemo(() => {
    if (!activeSessionId) return 'No terminal';
    const row = sessions.find((s) => s.hostId === activeHostId && s.id === activeSessionId);
    return row ? sessionLabel(row) : activeSessionId;
  }, [sessions, activeHostId, activeSessionId]);

  return {
    ready,
    hosts,
    passwords,
    sessions,
    healthByHost,
    activeHost,
    activeHostId,
    activeSessionId,
    activePassword,
    activeSessionLabel,
    screen,
    editingHostId,
    gitOpen,
    gitMode,
    setScreen,
    setEditingHostId,
    setGitOpen,
    setGitMode,
    settingsHostId,
    setSettingsHostId,
    selectHost,
    selectSession,
    newSession,
    killSessionById,
    renameSessionById,
    retryHost,
    saveHost,
    pairHost,
    removeHost,
    updateHostIdentity,
    updateHostConnection,
    updateHostPassword,
    handleWsFrame,
  };
}

export type TetherDesktop = ReturnType<typeof useTetherDesktop>;
