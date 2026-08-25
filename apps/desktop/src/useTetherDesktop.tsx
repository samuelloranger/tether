import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FrameApplyResult } from './frameHandler';
import {
  createHostClient,
  killSession,
  nextTermId,
  renameSession,
  type TetherSession,
  testConnection,
} from './hostClient';
import { type HostHealth, type HostHealthStatus, initialHostHealth } from './hostHealth';
import { applyPollHealth, createHostPolling, type PollResult } from './hostPolling';
import {
  activeSessionStorageKey,
  createDefaultHostStore,
  type HostProfile,
  KEY_ACTIVE_HOST,
} from './hostStore';
import { hostSecrets } from './secureConfig';
import { sessionLabel } from './sessionLabel';

export interface DrawerSession extends TetherSession {
  hostId: string;
}

type Screen = 'main' | 'hosts' | 'host-form' | 'settings';

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: desktop app state hook mirrors mobile session runtime scope
export function useTetherDesktop() {
  const store = useMemo(() => createDefaultHostStore(hostSecrets), []);
  const [ready, setReady] = useState(false);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<DrawerSession[]>([]);
  const [healthByHost, setHealthByHost] = useState<Record<string, HostHealthStatus>>({});
  const healthRef = useRef<Map<string, HostHealth>>(new Map());
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState('term-1');
  const [screen, setScreen] = useState<Screen>('main');
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [terminalKey, setTerminalKey] = useState(0);

  const activeHostIdRef = useRef<string | null>(null);
  const hostsRef = useRef<HostProfile[]>([]);
  const passwordsRef = useRef<Record<string, string>>({});

  activeHostIdRef.current = activeHostId;
  hostsRef.current = hosts;
  passwordsRef.current = passwords;

  const clientFor = useCallback((profile: HostProfile) => {
    const password = passwordsRef.current[profile.id] ?? '';
    return createHostClient(profile, password);
  }, []);

  const updateHealth = useCallback((profile: HostProfile, result: PollResult) => {
    const previous = healthRef.current.get(profile.id) ?? initialHostHealth();
    const next = applyPollHealth(previous, result);
    healthRef.current.set(profile.id, next);
    setHealthByHost((current) => ({ ...current, [profile.id]: next.status }));
  }, []);

  const pollingRef = useRef<ReturnType<typeof createHostPolling> | null>(null);

  const mergeSessions = useCallback((profile: HostProfile, rows: unknown[]) => {
    const mapped = (rows as Omit<DrawerSession, 'hostId'>[]).map((row) => ({
      ...row,
      hostId: profile.id,
    }));
    setSessions((previous) => [...previous.filter((row) => row.hostId !== profile.id), ...mapped]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const listed = await store.list();
      const loaded: Record<string, string> = {};
      for (const profile of listed) {
        const password = await hostSecrets.get(profile.id);
        if (password) loaded[profile.id] = password;
      }
      if (cancelled) return;
      setHosts(listed);
      setPasswords(loaded);
      for (const profile of listed) {
        healthRef.current.set(profile.id, initialHostHealth());
        setHealthByHost((current) => ({ ...current, [profile.id]: 'unknown' }));
      }
      const savedHost = localStorage.getItem(KEY_ACTIVE_HOST);
      const initialHost =
        listed.find((profile) => profile.id === savedHost)?.id ?? listed[0]?.id ?? null;
      if (initialHost) {
        setActiveHostId(initialHost);
        const savedSession = localStorage.getItem(activeSessionStorageKey(initialHost));
        if (savedSession) setActiveSessionId(savedSession);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(() => {
    if (!ready || hosts.length === 0) return undefined;
    pollingRef.current?.stop();
    const polling = createHostPolling({
      getProfiles: () => hostsRef.current,
      getActiveHostId: () => activeHostIdRef.current,
      getHealth: (profile) => healthRef.current.get(profile.id) ?? initialHostHealth(),
      clientFor,
      onSessions: mergeSessions,
      onHealth: updateHealth,
    });
    pollingRef.current = polling;
    void polling.start();
    return () => polling.stop();
  }, [ready, hosts, clientFor, mergeSessions, updateHealth]);

  const activeHost = hosts.find((host) => host.id === activeHostId) ?? null;
  const activePassword = activeHost ? (passwords[activeHost.id] ?? '') : '';

  const selectHost = useCallback((hostId: string) => {
    setActiveHostId(hostId);
    localStorage.setItem(KEY_ACTIVE_HOST, hostId);
    const savedSession = localStorage.getItem(activeSessionStorageKey(hostId));
    if (savedSession) setActiveSessionId(savedSession);
    setTerminalKey((value) => value + 1);
    setScreen('main');
  }, []);

  const selectSession = useCallback((hostId: string, sessionId: string) => {
    setActiveHostId(hostId);
    setActiveSessionId(sessionId);
    localStorage.setItem(KEY_ACTIVE_HOST, hostId);
    localStorage.setItem(activeSessionStorageKey(hostId), sessionId);
    setTerminalKey((value) => value + 1);
    setScreen('main');
  }, []);

  const newSession = useCallback(() => {
    if (!activeHostId) return;
    const ids = sessions.filter((row) => row.hostId === activeHostId).map((row) => row.id);
    selectSession(activeHostId, nextTermId(ids));
  }, [activeHostId, sessions, selectSession]);

  const killSessionById = useCallback(
    async (hostId: string, sessionId: string) => {
      const profile = hostsRef.current.find((host) => host.id === hostId);
      if (!profile) return;
      try {
        await killSession(clientFor(profile), sessionId);
      } catch {
        // refresh either way
      }
      if (hostId === activeHostId && sessionId === activeSessionId) {
        const remaining = sessions
          .filter((row) => row.hostId === hostId && row.id !== sessionId)
          .map((row) => row.id);
        selectSession(hostId, remaining[0] ?? 'term-1');
      }
      pollingRef.current?.restart();
    },
    [activeHostId, activeSessionId, clientFor, sessions, selectSession],
  );

  const renameSessionById = useCallback(
    async (hostId: string, sessionId: string, name: string) => {
      const profile = hostsRef.current.find((host) => host.id === hostId);
      if (!profile) return;
      await renameSession(clientFor(profile), sessionId, name);
      setSessions((previous) =>
        previous.map((row) =>
          row.hostId === hostId && row.id === sessionId ? { ...row, name: name || null } : row,
        ),
      );
    },
    [clientFor],
  );

  const retryHost = useCallback((hostId: string) => {
    healthRef.current.set(hostId, initialHostHealth());
    setHealthByHost((current) => ({ ...current, [hostId]: 'unknown' }));
    pollingRef.current?.restart();
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
      const client = createHostClient(
        {
          id: input.id ?? 'pending',
          name: input.name,
          color: '#89b4fa',
          host: input.host,
          port: input.port,
          identityName: '',
          order: 0,
        },
        input.password,
      );
      const result = await testConnection(client, input.password, input.confirmPassword ?? '');
      if (!result.ok) throw new Error(result.msg);

      let profile: HostProfile;
      if (input.id) {
        profile = await store.update(input.id, {
          name: input.name,
          host: input.host,
          port: input.port,
        });
      } else {
        profile = await store.create({
          name: input.name,
          color: '#89b4fa',
          host: input.host,
          port: input.port,
          identityName: '',
        });
      }
      await hostSecrets.set(profile.id, input.password);
      setPasswords((current) => ({ ...current, [profile.id]: input.password }));
      const listed = await store.list();
      setHosts(listed);
      setActiveHostId(profile.id);
      localStorage.setItem(KEY_ACTIVE_HOST, profile.id);
      pollingRef.current?.restart();
      setScreen('main');
      setEditingHostId(null);
    },
    [store],
  );

  const removeHost = useCallback(
    async (hostId: string) => {
      await store.remove(hostId);
      setHosts(await store.list());
      setPasswords((current) => {
        const next = { ...current };
        delete next[hostId];
        return next;
      });
      setSessions((current) => current.filter((row) => row.hostId !== hostId));
      healthRef.current.delete(hostId);
      setHealthByHost((current) => {
        const next = { ...current };
        delete next[hostId];
        return next;
      });
      if (activeHostId === hostId) {
        const remaining = hostsRef.current.filter((host) => host.id !== hostId);
        setActiveHostId(remaining[0]?.id ?? null);
      }
      pollingRef.current?.restart();
    },
    [activeHostId, store],
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
    sessions,
    healthByHost,
    activeHost,
    activeHostId,
    activeSessionId,
    activePassword,
    activeSessionLabel,
    screen,
    editingHostId,
    terminalKey,
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
    clientFor,
    store,
  };
}

export type TetherDesktop = ReturnType<typeof useTetherDesktop>;
