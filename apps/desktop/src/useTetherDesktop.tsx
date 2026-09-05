// biome-ignore-all lint/style/noExcessiveLinesPerFile: desktop app state hook — owns hosts, sessions, pairing, and the screen state machine in one place
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  coreCacheDelete,
  coreHostRetry,
  coreHostsList,
  coreHostsMigrate,
  coreHostsRemove,
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
  listenSessions,
} from './coreApi';
import type { FrameApplyResult } from './frameHandler';
import type { PairScheme } from './hostScheme';
import { markNoiseHost, noiseSessionAddress, unmarkNoiseHost } from './noiseHosts';
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

type Screen = 'main' | 'hosts' | 'pair-device' | 'settings' | 'local-settings' | 'devices';

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: desktop app state hook mirrors mobile session runtime scope
export function useTetherDesktop() {
  const [ready, setReady] = useState(false);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [sessions, setSessions] = useState<DrawerSession[]>([]);
  const [healthByHost, setHealthByHost] = useState<Record<string, HostHealthStatus>>({});
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  // '' means "no terminal open". It used to default to 'term-1', which the WS
  // open path turns into `startSession` — so a launch with nothing remembered
  // spawned a shell nobody asked for.
  const [activeSessionId, setActiveSessionId] = useState('');
  const [screen, setScreen] = useState<Screen>('main');
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
    let unlistenSessions: (() => void) | undefined;
    void (async () => {
      const legacy = localStorage.getItem(HOST_PROFILES_KEY);
      const listed = await coreHostsMigrate(legacy);
      if (legacy) localStorage.removeItem(HOST_PROFILES_KEY);
      if (cancelled) return;
      setHosts(listed);
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
      unlistenSessions = await listenSessions((hostId, rows) => {
        setSessions((previous) => [...previous.filter((row) => row.hostId !== hostId), ...rows]);
      });
      if (listed.length > 0) await corePollingStart();
      setReady(true);
    })();
    return () => {
      cancelled = true;
      unlistenSessions?.();
      void corePollingStop();
    };
  }, [restoreSession]);

  useEffect(() => {
    if (!ready) return;
    void corePollingSetActive(activeHostId);
  }, [ready, activeHostId]);

  // Health: probe reachability over Noise (a reconnect handshake). A success
  // means up + still authorized; a failure (host down, or this device revoked)
  // shows unreachable.
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    const pingAll = async () => {
      for (const host of hostsRef.current) {
        let ok = false;
        try {
          ok = await coreNoisePing(host.id, noiseSessionAddress(host));
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

  /**
   * Pair a new host over Noise, then persist it.
   *
   * The profile is created FIRST so the pinned device + server keys land under
   * its real id — reconnect (`coreNoiseReconnect`) namespaces its keys by the
   * host profile id, so pairing under any other id would strand them. If pairing
   * itself fails after the profile exists, the orphan profile is removed.
   */
  const pairHost = useCallback(
    async (
      input: {
        name: string;
        host: string;
        port: string;
        scheme: PairScheme;
        address: string;
        code: string;
      },
      onProgress?: (progress: { deviceFingerprint: string }) => void,
    ): Promise<{ fingerprint: string }> => {
      const profile = await coreHostsSaveNoise({
        name: input.name,
        host: input.host,
        port: input.port,
        scheme: input.scheme,
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
    async (hostId: string, changes: Pick<HostProfile, 'host' | 'port'>) => {
      await coreHostsUpdateConnection(hostId, {
        host: changes.host,
        port: changes.port,
      });
      setHosts(await coreHostsList());
    },
    [],
  );

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
    sessions,
    healthByHost,
    activeHost,
    activeHostId,
    activeSessionId,
    activeSessionLabel,
    screen,
    gitOpen,
    gitMode,
    setScreen,
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
    pairHost,
    removeHost,
    updateHostIdentity,
    updateHostConnection,
    handleWsFrame,
  };
}

export type TetherDesktop = ReturnType<typeof useTetherDesktop>;
