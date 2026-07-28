import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { newlyWaiting, type SessionActivity } from '../activity';
import { notify as sendNativeNotification } from '../desktopNotify';
import { isDesktop } from '../platform';
import { resumeAction } from '../resume';
import type { DrawerSession } from '../SessionDrawer';
import { nextTermId, type SessionEntry } from '../sessionCache';
import { sessionLabel } from '../sessionLabel';
import type { TerminalViewHandle } from '../TerminalView.types';
import { TerminalEngine } from '../terminalEngine';
import { OutputBatcher } from '../terminalRendererProtocol';
import type { HostClient } from './hostClient';
import {
  type HostHealth,
  type HostHealthStatus,
  hostHealthAfterFailure,
  hostHealthAfterResponse,
  initialHostHealth,
} from './hostHealth';
import { createHostPolling, type PollResult } from './hostPolling';
import type { HostProfile } from './hostStore';
import {
  applyWsMessage,
  backoffDelay,
  createSessionCache,
  focusFrame,
  maybeNotify,
  parseSessionKey,
  scheduleReconnect,
  sessionKey,
  sessionSwitchAction,
  statusAfterClose,
} from './terminalSessionLogic';
import type { ConnectionStatus, TerminalConnectionState } from './types';

const KEY_ACTIVE_HOST = 'tether_active_host';
const activeSessionStorageKey = (hostId: string) => `tether_session_id_${hostId}`;

type Options = {
  client: HostClient;
  profiles: HostProfile[];
  clientFor: (profile: HostProfile) => HostClient;
  onReachable?: (profile: HostProfile) => void;
  ready: boolean;
  isConfiguring: boolean;
  theme: { terminal: { fg: string; bg: string } };
  fontFamily: string;
  fontSize: number;
  notificationsEnabledRef: React.MutableRefObject<boolean>;
  onClearView: () => void;
  onClearPresentation: () => void;
  onCloseDrawer: () => void;
};

export function useTerminalSessions({
  client,
  profiles,
  clientFor,
  onReachable,
  ready,
  isConfiguring,
  theme,
  fontFamily,
  fontSize,
  notificationsEnabledRef,
  onClearView,
  onClearPresentation,
  onCloseDrawer,
}: Options) {
  const initialKey = sessionKey(client.profile.id, 'term-1');
  const [activeId, setActiveId] = useState('term-1');
  const activeIdRef = useRef('term-1');
  const [activeHostId, setActiveHostId] = useState(client.profile.id);
  const activeHostIdRef = useRef(client.profile.id);
  const activeKeyRef = useRef(initialKey);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const connectionStatusRef = useRef(connectionStatus);
  connectionStatusRef.current = connectionStatus;
  const [hasConnected, setHasConnected] = useState(false);
  const [drawerSessions, setDrawerSessions] = useState<DrawerSession[]>([]);
  const drawerSessionsRef = useRef(drawerSessions);
  drawerSessionsRef.current = drawerSessions;
  const [healthByHost, setHealthByHost] = useState<Record<string, HostHealthStatus>>({});
  const healthRef = useRef(new Map<string, HostHealth>());
  const [_terminalMetadataVersion, setTerminalMetadataVersion] = useState(0);
  const [_gitSummaryVersion, setGitSummaryVersion] = useState(0);
  const terminalViewRef = useRef<TerminalViewHandle | null>(null);
  const terminalSelectionRef = useRef('');
  const dimsRef = useRef({ numCols: 80, numRows: 24 });
  const rendererResizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowFocusedRef = useRef(true);
  const appStateRef = useRef(AppState.currentState);
  const clientRef = useRef(client);
  clientRef.current = client;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const disconnectRef = useRef<(key: string) => void>(() => {});
  const cache = useRef(createSessionCache((key) => disconnectRef.current(key))).current;
  const connections = useRef(new Map<string, TerminalConnectionState>()).current;
  const lastActivityRef = useRef(new Map<string, SessionActivity | null | undefined>());
  const outputBatcherRef = useRef<OutputBatcher | null>(null);
  if (!outputBatcherRef.current) {
    outputBatcherRef.current = new OutputBatcher(
      () => activeKeyRef.current,
      (data) => terminalViewRef.current?.write(data),
      (flush) => requestAnimationFrame(flush),
    );
  }
  const outputBatcher = outputBatcherRef.current;

  const clientForKey = (key: string): HostClient => {
    const { hostId } = parseSessionKey(key);
    if (hostId === clientRef.current.profile.id) return clientRef.current;
    return (
      connections.get(key)?.client ??
      (profiles.find((profile) => profile.id === hostId)
        ? clientFor(profiles.find((profile) => profile.id === hostId)!)
        : clientRef.current)
    );
  };
  const connState = (key: string): TerminalConnectionState => {
    let state = connections.get(key);
    if (!state) {
      state = {
        client: clientForKey(key),
        sock: null,
        gen: 0,
        open: false,
        reconnectTimeout: null,
        retry: 0,
        ping: null,
        lastSeen: 0,
      };
      connections.set(key, state);
    }
    return state;
  };
  const entryForKey = (key: string): SessionEntry =>
    cache.touch(key, () => {
      const { numCols: cols, numRows: rows } = dimsRef.current;
      const term = new TerminalEngine(cols || 80, rows || 24);
      term.onReply = null;
      term.onClipboardWrite = null;
      return {
        term,
        sinceId: 0,
        lastAppliedId: 0,
        diffSummary: { files: [] },
        lastBellCount: 0,
        lastNotifyCount: 0,
      };
    });
  const entryFor = (id: string): SessionEntry =>
    entryForKey(sessionKey(activeHostIdRef.current, id));
  const notifyWaitingSessions = (rows: DrawerSession[]) => {
    const alerts = newlyWaiting(lastActivityRef.current, rows, activeIdRef.current);
    for (const row of rows) lastActivityRef.current.set(row.id, row.activity);
    if (!isDesktop) return;
    for (const row of alerts)
      void sendNativeNotification(sessionLabel(row), 'Session is waiting for your input');
  };
  const sendFocus = (focused: boolean) => {
    const state = connections.get(activeKeyRef.current);
    if (state?.open && state.sock) state.sock.send(JSON.stringify(focusFrame(focused)));
  };
  const wsSend = (object: unknown) => {
    const state = connections.get(activeKeyRef.current);
    if (state?.open && state.sock) state.sock.send(JSON.stringify(object));
  };
  const hydrateRenderer = (key = activeKeyRef.current) => {
    const entry = entryForKey(key);
    outputBatcher.clear();
    terminalViewRef.current?.hydrate(
      entry.term.serialize(),
      entry.term.cols,
      entry.term.rows,
      { foreground: theme.terminal.fg, background: theme.terminal.bg },
      fontFamily,
      fontSize,
    );
  };
  const onRendererResize = (cols: number, rows: number) => {
    if (dimsRef.current.numCols === cols && dimsRef.current.numRows === rows) return;
    dimsRef.current = { numCols: cols, numRows: rows };
    cache.get(activeKeyRef.current)?.term.resize(cols, rows);
    if (rendererResizeTimer.current) clearTimeout(rendererResizeTimer.current);
    rendererResizeTimer.current = setTimeout(
      () => {
        wsSend({ type: 'resize', cols, rows });
        rendererResizeTimer.current = null;
      },
      isDesktop ? 120 : 60,
    );
  };
  const onRendererSelection = (text: string) => {
    terminalSelectionRef.current = text;
  };
  const resetTerminal = () => {
    const entry = cache.get(activeKeyRef.current);
    if (!entry) return;
    entry.term.reset();
    entry.sinceId = 0;
    entry.lastAppliedId = 0;
    hydrateRenderer();
  };
  const handleWsMessage = (key: string, data: string) => {
    const { sessionId } = parseSessionKey(key);
    try {
      applyWsMessage({
        id: key,
        drawerSessionId: sessionId,
        drawerHostId: parseSessionKey(key).hostId,
        message: JSON.parse(data),
        entry: cache.get(key),
        activeId: activeKeyRef.current,
        onGitSummaryChanged: () => setGitSummaryVersion((version) => version + 1),
        onTerminalMetadataChanged: () => setTerminalMetadataVersion((version) => version + 1),
        onDrawerSessions: (update) =>
          setDrawerSessions((previous) => {
            const next = update(previous);
            drawerSessionsRef.current = next;
            return next;
          }),
        onWaitingSessions: notifyWaitingSessions,
        onOutput: (sessionKey, chunk) => outputBatcher.push(sessionKey, chunk),
        onNotify: (sessionKey, session) =>
          maybeNotify({
            id: sessionKey,
            entry: session,
            activeId: activeKeyRef.current,
            windowFocused: windowFocusedRef.current,
            notificationsEnabled: notificationsEnabledRef.current,
            isDesktop,
            label: sessionLabel(
              drawerSessionsRef.current.find(
                (row) => row.id === sessionId && row.hostId === parseSessionKey(key).hostId,
              ) ?? { id: sessionId },
            ),
            notify: (title, body) => void sendNativeNotification(title, body),
          }),
        hydrateRenderer,
      });
    } catch (error) {
      console.error('ws message error:', error);
    }
  };
  const disconnect = (key: string) => {
    const state = connections.get(key);
    if (!state) return;
    if (state.reconnectTimeout) clearTimeout(state.reconnectTimeout);
    if (state.ping) clearInterval(state.ping);
    state.gen++;
    state.open = false;
    state.sock?.close();
    connections.delete(key);
    if (key === activeKeyRef.current) setConnectionStatus('disconnected');
  };
  const disconnectAll = () => {
    for (const key of Array.from(connections.keys())) disconnect(key);
  };
  const connect = (key: string) => {
    disconnect(key);
    const { sessionId } = parseSessionKey(key);
    const entry = entryForKey(key);
    const state = connState(key);
    state.client = clientForKey(key);
    if (key === activeKeyRef.current) setConnectionStatus('connecting');
    const generation = ++state.gen;
    try {
      state.sock = state.client.openSocket(
        '/api/ws',
        {
          sessionId,
          sinceId: entry.sinceId,
          cols: dimsRef.current.numCols,
          rows: dimsRef.current.numRows,
        },
        {
          onOpen: () => {
            if (state.gen !== generation) return;
            state.open = true;
            state.retry = 0;
            if (key === activeKeyRef.current) {
              setHasConnected(true);
              setConnectionStatus('connected');
              state.sock?.send(JSON.stringify(focusFrame(appStateRef.current === 'active')));
            } else state.sock?.send(JSON.stringify(focusFrame(false)));
            state.lastSeen = Date.now();
            if (state.ping) clearInterval(state.ping);
            state.ping = setInterval(() => {
              if (Date.now() - state.lastSeen > 30_000)
                try {
                  state.sock?.close();
                } catch {}
            }, 15_000);
          },
          onMessage: (data) => {
            if (state.gen !== generation) return;
            state.lastSeen = Date.now();
            handleWsMessage(key, data);
          },
          onClose: () => {
            if (state.gen !== generation) return;
            state.open = false;
            if (state.ping) {
              clearInterval(state.ping);
              state.ping = null;
            }
            if (connectionStatusRef.current === 'auth-failed') {
              state.retry = 0;
              return;
            }
            setConnectionStatus((current) => statusAfterClose(activeKeyRef.current, key, current));
            if (cache.has(key))
              state.reconnectTimeout = scheduleReconnect({
                id: key,
                readyRef,
                delay: backoffDelay(state.retry++),
                schedule: setTimeout,
                reconnect: connect,
              });
          },
        },
      );
    } catch {
      state.open = false;
      if (key === activeKeyRef.current) setConnectionStatus('disconnected');
    }
  };
  disconnectRef.current = disconnect;
  const updateHealth = (profile: HostProfile, result: PollResult) => {
    const current = healthRef.current.get(profile.id) ?? initialHostHealth();
    const next =
      result === 'success'
        ? hostHealthAfterResponse(current, 200)
        : result === 'unauthorized'
          ? hostHealthAfterResponse(current, 401)
          : hostHealthAfterFailure(current);
    healthRef.current.set(profile.id, next);
    setHealthByHost((previous) => ({ ...previous, [profile.id]: next.status }));
  };
  const refreshSessionsFor = async (profile: HostProfile) => {
    const refreshClient = clientFor(profile);
    try {
      const response = await refreshClient.get('/api/sessions');
      if (response.status === 401) {
        updateHealth(profile, 'unauthorized');
        if (profile.id === activeHostIdRef.current) setConnectionStatus('auth-failed');
        return;
      }
      if (!response.ok) throw new Error(`Session polling failed (${response.status})`);
      const sessions = await response.json();
      if (!Array.isArray(sessions)) throw new Error('Session response was not an array');
      const rows = sessions.map((row) => ({
        ...(row as Omit<DrawerSession, 'hostId'>),
        hostId: profile.id,
      })) as DrawerSession[];
      setDrawerSessions((previous) => [
        ...previous.filter((row) => row.hostId !== profile.id),
        ...rows,
      ]);
      if (profile.id === activeHostIdRef.current) notifyWaitingSessions(rows);
      updateHealth(profile, 'success');
    } catch {
      updateHealth(profile, 'failure');
    }
  };
  const refreshSessions = async () => {
    const profile =
      profiles.find((candidate) => candidate.id === activeHostIdRef.current) ??
      clientRef.current.profile;
    await refreshSessionsFor(profile);
  };
  const switchTo = (hostId: string, id: string) => {
    const targetKey = sessionKey(hostId, id);
    const previousKey = activeKeyRef.current;
    const action = sessionSwitchAction(previousKey, targetKey, cache.has(targetKey));
    onCloseDrawer();
    onClearView();
    if (action === 'none') return;
    sendFocus(false);
    activeHostIdRef.current = hostId;
    activeIdRef.current = id;
    activeKeyRef.current = targetKey;
    setActiveHostId(hostId);
    setActiveId(id);
    void AsyncStorage.multiSet([
      [KEY_ACTIVE_HOST, hostId],
      [activeSessionStorageKey(hostId), id],
    ]);
    entryForKey(targetKey);
    hydrateRenderer(targetKey);
    if (action === 'hydrate') {
      setConnectionStatus(connections.get(targetKey)?.open ? 'connected' : 'disconnected');
      sendFocus(true);
    } else connect(targetKey);
  };
  const newTerminal = () => {
    const hostId = activeHostIdRef.current;
    const existing = drawerSessions.length
      ? drawerSessions.map((row) => row.id)
      : cache
          .ids()
          .map(parseSessionKey)
          .filter((key) => key.hostId === hostId)
          .map((key) => key.sessionId);
    switchTo(hostId, nextTermId(existing));
  };
  const killActiveOr = async (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const hostId = activeHostIdRef.current;
    const key = sessionKey(hostId, id);
    try {
      await clientRef.current.post('/api/sessions/kill', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {}
    cache.delete(key);
    disconnect(key);
    const remaining = drawerSessions.filter((row) => row.id !== id).map((row) => row.id);
    await refreshSessions();
    if (key === activeKeyRef.current) {
      onClearPresentation();
      switchTo(hostId, remaining[0] ?? 'term-1');
    }
  };
  const resetForEndpointChange = () => {
    setHasConnected(false);
    disconnectAll();
    resetTerminal();
    connect(activeKeyRef.current);
  };
  const refreshSocketActivity = () => {
    const now = Date.now();
    for (const state of connections.values()) if (state.open) state.lastSeen = now;
  };
  const markAuthFailed = () => setConnectionStatus('auth-failed');
  const restartActiveSession = () => connect(activeKeyRef.current);
  const getActiveSessionId = () => activeIdRef.current;
  const getSessionEntry = (id: string) => cache.get(sessionKey(activeHostIdRef.current, id));
  const getTerminalSelection = () => terminalSelectionRef.current;
  const setWindowFocused = (focused: boolean) => {
    windowFocusedRef.current = focused;
  };
  const isWindowFocused = () => windowFocusedRef.current;
  const activeClient = clientForKey(activeKeyRef.current);

  useEffect(() => {
    const hostId = client.profile.id;
    if (hostId === 'pending') return;
    if (activeHostIdRef.current === 'pending') {
      activeHostIdRef.current = hostId;
      activeKeyRef.current = sessionKey(hostId, activeIdRef.current);
      setActiveHostId(hostId);
    }
    void AsyncStorage.getItem(activeSessionStorageKey(hostId)).then((savedId) => {
      if (!savedId) return;
      activeHostIdRef.current = hostId;
      activeIdRef.current = savedId;
      activeKeyRef.current = sessionKey(hostId, savedId);
      setActiveHostId(hostId);
      setActiveId(savedId);
    });
  }, [client.profile.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: repaint is intentionally keyed to terminal view inputs.
  useEffect(() => {
    hydrateRenderer();
  }, [activeId, activeHostId, theme, fontFamily, fontSize]);
  useEffect(() => {
    if (isConfiguring || profiles.length === 0) return;
    const polling = createHostPolling({
      getProfiles: () => profiles,
      getActiveHostId: () => activeHostIdRef.current,
      getHealth: (profile) => healthRef.current.get(profile.id) ?? initialHostHealth(),
      clientFor,
      onSessions: (profile, sessions) => {
        const rows = (sessions as Omit<DrawerSession, 'hostId'>[]).map((row) => ({
          ...row,
          hostId: profile.id,
        }));
        setDrawerSessions((previous) => [
          ...previous.filter((row) => row.hostId !== profile.id),
          ...rows,
        ]);
        if (profile.id === activeHostIdRef.current) notifyWaitingSessions(rows);
      },
      onHealth: (profile, result) => {
        updateHealth(profile, result);
        if (result === 'success') void onReachable?.(profile);
      },
    });
    void polling.start().catch(() => {});
    return polling.stop;
  }, [clientFor, isConfiguring, profiles]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: connect reads the current client ref at call time.
  useEffect(() => {
    if (!ready) return;
    connect(activeKeyRef.current);
    return disconnectAll;
  }, [ready]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resume callbacks read active transport state at event time.
  useEffect(() => {
    if (!ready) return;
    sendFocus(true);
    const subscription = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
      if (state === 'background' || state === 'inactive') {
        sendFocus(false);
        return;
      }
      if (state !== 'active') return;
      sendFocus(true);
      for (const [key, connection] of Array.from(connections))
        switch (resumeAction(connection, Date.now())) {
          case 'reconnect':
            connection.retry = 0;
            connect(key);
            break;
          case 'close':
            try {
              connection.sock?.close();
            } catch {}
            break;
        }
    });
    return () => subscription.remove();
  }, [ready]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount cleanup owns the transport created by this hook.
  useEffect(
    () => () => {
      disconnectAll();
      outputBatcher.clear();
      if (rendererResizeTimer.current) clearTimeout(rendererResizeTimer.current);
    },
    [],
  );

  return {
    activeId,
    activeHostId,
    activeClient,
    connectionStatus,
    hasConnected,
    drawerSessions,
    healthByHost,
    terminalViewRef,
    entryFor,
    getSessionEntry,
    getActiveSessionId,
    getTerminalSelection,
    wsSend,
    hydrateRenderer,
    onRendererResize,
    onRendererSelection,
    resetTerminal,
    switchTo,
    newTerminal,
    killActiveOr,
    refreshSessions,
    refreshHost: (hostId: string) => {
      const profile = profiles.find((candidate) => candidate.id === hostId);
      if (profile) void refreshSessionsFor(profile);
    },
    resetHostHealth: (hostId: string) => {
      healthRef.current.set(hostId, initialHostHealth());
      setHealthByHost((previous) => ({ ...previous, [hostId]: 'unknown' }));
    },
    removeHost: (hostId: string) => {
      for (const key of Array.from(connections.keys())) {
        if (parseSessionKey(key).hostId === hostId) disconnect(key);
      }
      for (const key of cache.ids()) {
        if (parseSessionKey(key).hostId === hostId) cache.delete(key);
      }
      setDrawerSessions((previous) => previous.filter((row) => row.hostId !== hostId));
      setHealthByHost((previous) => {
        const { [hostId]: _removed, ...rest } = previous;
        return rest;
      });
    },
    resetForEndpointChange,
    restartActiveSession,
    markAuthFailed,
    refreshSocketActivity,
    setWindowFocused,
    isWindowFocused,
  };
}
