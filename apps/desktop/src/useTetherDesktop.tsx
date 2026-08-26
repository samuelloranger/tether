import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  coreCacheDelete,
  coreHostRetry,
  coreHostsList,
  coreHostsMigrate,
  coreHostsRemove,
  coreHostsSave,
  coreNextTermId,
  corePollingRestart,
  corePollingSetActive,
  corePollingStart,
  corePollingStop,
  coreSessionsKill,
  coreSessionsRename,
  listenHostHealth,
  listenSessions,
} from './coreApi';
import type { FrameApplyResult } from './frameHandler';
import { hostSecrets } from './secureConfig';
import { sessionKey } from './sessionKey';
import { sessionLabel } from './sessionLabel';
import {
  activeSessionStorageKey,
  type DrawerSession,
  HOST_PROFILES_KEY,
  type HostHealthStatus,
  type HostProfile,
  KEY_ACTIVE_HOST,
} from './types';

export type { DrawerSession } from './types';

type Screen = 'main' | 'hosts' | 'host-form' | 'settings';

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: desktop app state hook mirrors mobile session runtime scope
export function useTetherDesktop() {
  const [ready, setReady] = useState(false);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<DrawerSession[]>([]);
  const [healthByHost, setHealthByHost] = useState<Record<string, HostHealthStatus>>({});
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState('term-1');
  const [screen, setScreen] = useState<Screen>('main');
  const [editingHostId, setEditingHostId] = useState<string | null>(null);

  const activeHostIdRef = useRef<string | null>(null);
  const hostsRef = useRef<HostProfile[]>([]);
  const sessionsRef = useRef<DrawerSession[]>([]);
  const activeSessionIdRef = useRef(activeSessionId);

  activeHostIdRef.current = activeHostId;
  hostsRef.current = hosts;
  sessionsRef.current = sessions;
  activeSessionIdRef.current = activeSessionId;

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
        localStorage.setItem(KEY_ACTIVE_HOST, initialHost);
        await corePollingSetActive(initialHost);
        const savedSession = localStorage.getItem(activeSessionStorageKey(initialHost));
        if (savedSession) setActiveSessionId(savedSession);
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
  }, []);

  useEffect(() => {
    if (!ready) return;
    void corePollingSetActive(activeHostId);
  }, [ready, activeHostId]);

  const activeHost = hosts.find((host) => host.id === activeHostId) ?? null;
  const activePassword = activeHost ? (passwords[activeHost.id] ?? '') : '';

  const selectHost = useCallback((hostId: string) => {
    setActiveHostId(hostId);
    localStorage.setItem(KEY_ACTIVE_HOST, hostId);
    const savedSession = localStorage.getItem(activeSessionStorageKey(hostId));
    if (savedSession) setActiveSessionId(savedSession);
    setScreen('main');
  }, []);

  const selectSession = useCallback((hostId: string, sessionId: string) => {
    setActiveHostId(hostId);
    setActiveSessionId(sessionId);
    localStorage.setItem(KEY_ACTIVE_HOST, hostId);
    localStorage.setItem(activeSessionStorageKey(hostId), sessionId);
    setScreen('main');
  }, []);

  const newSession = useCallback(() => {
    if (!activeHostId) return;
    const ids = sessions.filter((row) => row.hostId === activeHostId).map((row) => row.id);
    void coreNextTermId(ids).then((nextId) => selectSession(activeHostId, nextId));
  }, [activeHostId, sessions, selectSession]);

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
    setScreen,
    setEditingHostId,
    selectHost,
    selectSession,
    newSession,
    killSessionById,
    renameSessionById,
    retryHost,
    saveHost,
    removeHost,
    handleWsFrame,
  };
}

export type TetherDesktop = ReturnType<typeof useTetherDesktop>;
