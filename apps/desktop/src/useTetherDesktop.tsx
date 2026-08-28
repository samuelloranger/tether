import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  coreCacheDelete,
  coreHostRetry,
  coreHostsList,
  coreHostsMigrate,
  coreHostsRemove,
  coreHostsSave,
  coreHostsUpdateConnection,
  coreHostsUpdateIdentity,
  coreNextTermId,
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

type Screen = 'main' | 'hosts' | 'host-form' | 'settings' | 'local-settings';

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
    async (hostId: string) => {
      let ids = sessionsRef.current.filter((row) => row.hostId === hostId).map((row) => row.id);
      try {
        ids = (await coreSessionsList(hostId)).map((row) => row.id);
      } catch {
        // the poll's copy stands in
      }
      const nextId = await coreNextTermId(ids);
      selectSession(hostId, nextId);
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

  const removeHost = useCallback(
    async (hostId: string) => {
      await coreHostsRemove(hostId);
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
    removeHost,
    updateHostIdentity,
    updateHostConnection,
    updateHostPassword,
    handleWsFrame,
  };
}

export type TetherDesktop = ReturnType<typeof useTetherDesktop>;
