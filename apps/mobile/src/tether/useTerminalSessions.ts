import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { newlyWaiting, type SessionActivity } from '../activity';
import { httpBase } from '../address';
import { notify as sendNativeNotification } from '../desktopNotify';
import { isDesktop } from '../platform';
import { resumeAction } from '../resume';
import type { DrawerSession } from '../SessionDrawer';
import { authHeaders } from '../secureConfig';
import { nextTermId, type SessionEntry } from '../sessionCache';
import { sessionLabel } from '../sessionLabel';
import type { TerminalViewHandle } from '../TerminalView.types';
import { TerminalEngine } from '../terminalEngine';
import { OutputBatcher } from '../terminalRendererProtocol';
import { openTerminalSocket } from '../wsTransport';
import {
  applyWsMessage,
  backoffDelay,
  createSessionCache,
  maybeNotify,
  runIfCurrentGeneration,
  scheduleReconnect,
  terminalSocketUrl,
} from './terminalSessionLogic';
import type { ConnectionStatus, TerminalConnectionState } from './types';

const KEY_SESSION_ID = 'tether_session_id';

type Options = {
  serverIp: string;
  port: string;
  passwordRef: React.MutableRefObject<string>;
  lastConnectedRef: React.MutableRefObject<{ ip: string; port: string }>;
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
  serverIp,
  port,
  passwordRef,
  lastConnectedRef,
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
  const [activeId, setActiveId] = useState('term-1');
  const activeIdRef = useRef('term-1');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const connectionStatusRef = useRef(connectionStatus);
  connectionStatusRef.current = connectionStatus;
  const [hasConnected, setHasConnected] = useState(false);
  const [drawerSessions, setDrawerSessions] = useState<DrawerSession[]>([]);
  const drawerSessionsRef = useRef(drawerSessions);
  drawerSessionsRef.current = drawerSessions;
  const [_terminalMetadataVersion, setTerminalMetadataVersion] = useState(0);
  const [_gitSummaryVersion, setGitSummaryVersion] = useState(0);
  const terminalViewRef = useRef<TerminalViewHandle | null>(null);
  const terminalSelectionRef = useRef('');
  const dimsRef = useRef({ numCols: 80, numRows: 24 });
  const rendererResizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowFocusedRef = useRef(true);
  const endpointRef = useRef({ serverIp, port });
  endpointRef.current = { serverIp, port };
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const disconnectRef = useRef<(id: string) => void>(() => {});
  const cache = useRef(createSessionCache((id) => disconnectRef.current(id))).current;
  const connections = useRef(new Map<string, TerminalConnectionState>()).current;
  const lastActivityRef = useRef(new Map<string, SessionActivity | null | undefined>());
  const outputBatcherRef = useRef<OutputBatcher | null>(null);
  if (!outputBatcherRef.current) {
    outputBatcherRef.current = new OutputBatcher(
      () => activeIdRef.current,
      (data) => terminalViewRef.current?.write(data),
      (flush) => requestAnimationFrame(flush),
    );
  }
  const outputBatcher = outputBatcherRef.current;

  const connState = (id: string): TerminalConnectionState => {
    let state = connections.get(id);
    if (!state) {
      state = {
        sock: null,
        gen: 0,
        open: false,
        reconnectTimeout: null,
        retry: 0,
        ping: null,
        lastSeen: 0,
      };
      connections.set(id, state);
    }
    return state;
  };
  const entryFor = (id: string): SessionEntry =>
    cache.touch(id, () => {
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
  const notifyWaitingSessions = (rows: DrawerSession[]) => {
    const alerts = newlyWaiting(lastActivityRef.current, rows, activeIdRef.current);
    for (const row of rows) lastActivityRef.current.set(row.id, row.activity);
    if (!isDesktop) return;
    for (const row of alerts)
      void sendNativeNotification(sessionLabel(row), 'Session is waiting for your input');
  };
  const wsSend = (object: unknown) => {
    const state = connections.get(activeIdRef.current);
    if (state?.open && state.sock) state.sock.send(JSON.stringify(object));
  };
  const hydrateRenderer = (id = activeIdRef.current) => {
    const entry = entryFor(id);
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
    cache.get(activeIdRef.current)?.term.resize(cols, rows);
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
    const entry = cache.get(activeIdRef.current);
    if (!entry) return;
    entry.term.reset();
    entry.sinceId = 0;
    entry.lastAppliedId = 0;
    hydrateRenderer();
  };
  const handleWsMessage = (id: string, data: string) => {
    try {
      applyWsMessage({
        id,
        message: JSON.parse(data),
        entry: cache.get(id),
        activeId: activeIdRef.current,
        onGitSummaryChanged: () => setGitSummaryVersion((version) => version + 1),
        onTerminalMetadataChanged: () => setTerminalMetadataVersion((version) => version + 1),
        onDrawerSessions: (update) =>
          setDrawerSessions((previous) => {
            const next = update(previous);
            drawerSessionsRef.current = next;
            return next;
          }),
        onWaitingSessions: notifyWaitingSessions,
        onOutput: (sessionId, chunk) => outputBatcher.push(sessionId, chunk),
        onNotify: (sessionId, session) =>
          maybeNotify({
            id: sessionId,
            entry: session,
            activeId: activeIdRef.current,
            windowFocused: windowFocusedRef.current,
            notificationsEnabled: notificationsEnabledRef.current,
            isDesktop,
            label: sessionLabel(
              drawerSessionsRef.current.find((row) => row.id === sessionId) ?? { id: sessionId },
            ),
            notify: (title, body) => void sendNativeNotification(title, body),
          }),
        hydrateRenderer,
      });
    } catch (error) {
      console.error('ws message error:', error);
    }
  };
  const disconnect = (id: string) => {
    const state = connections.get(id);
    if (!state) return;
    if (state.reconnectTimeout) clearTimeout(state.reconnectTimeout);
    if (state.ping) clearInterval(state.ping);
    state.gen++;
    state.open = false;
    state.sock?.close();
    connections.delete(id);
    if (id === activeIdRef.current) setConnectionStatus('disconnected');
  };
  const disconnectAll = () => {
    for (const id of Array.from(connections.keys())) disconnect(id);
  };
  const connect = (id: string) => {
    disconnect(id);
    const endpoint = endpointRef.current;
    lastConnectedRef.current = { ip: endpoint.serverIp, port: endpoint.port };
    const entry = entryFor(id),
      state = connState(id);
    if (id === activeIdRef.current) setConnectionStatus('connecting');
    const generation = ++state.gen;
    state.sock = openTerminalSocket(
      terminalSocketUrl(endpoint, {
        sessionId: id,
        sinceId: entry.sinceId,
        cols: dimsRef.current.numCols,
        rows: dimsRef.current.numRows,
      }),
      passwordRef.current,
      {
        onOpen: () => {
          runIfCurrentGeneration(state, generation, () => {
            state.open = true;
            state.retry = 0;
            if (id === activeIdRef.current) {
              setHasConnected(true);
              setConnectionStatus('connected');
            }
            state.lastSeen = Date.now();
            if (state.ping) clearInterval(state.ping);
            state.ping = setInterval(() => {
              if (Date.now() - state.lastSeen > 30_000)
                try {
                  state.sock?.close();
                } catch {}
            }, 15_000);
          });
        },
        onMessage: (data) => {
          runIfCurrentGeneration(state, generation, () => {
            state.lastSeen = Date.now();
            handleWsMessage(id, data);
          });
        },
        onClose: () => {
          runIfCurrentGeneration(state, generation, () => {
            state.open = false;
            if (state.ping) {
              clearInterval(state.ping);
              state.ping = null;
            }
            if (connectionStatusRef.current === 'auth-failed') {
              state.retry = 0;
              return;
            }
            if (id === activeIdRef.current) setConnectionStatus('disconnected');
            if (cache.has(id))
              state.reconnectTimeout = scheduleReconnect({
                id,
                readyRef,
                delay: backoffDelay(state.retry++),
                schedule: setTimeout,
                reconnect: connect,
              });
          });
        },
      },
    );
  };
  disconnectRef.current = disconnect;
  const refreshSessions = async () => {
    try {
      const response = await fetch(`${httpBase(serverIp, port)}/api/sessions`, {
        headers: authHeaders(passwordRef.current),
      });
      if (response.status === 401) {
        setConnectionStatus('auth-failed');
        return;
      }
      const rows = (await response.json()) as DrawerSession[];
      setDrawerSessions(rows);
      notifyWaitingSessions(rows);
    } catch {}
  };
  const switchTo = (id: string) => {
    onCloseDrawer();
    onClearView();
    if (id === activeIdRef.current) return;
    activeIdRef.current = id;
    setActiveId(id);
    void AsyncStorage.setItem(KEY_SESSION_ID, id);
    entryFor(id);
    hydrateRenderer(id);
    if (connections.get(id)?.open) setConnectionStatus('connected');
    else connect(id);
  };
  const newTerminal = () =>
    switchTo(nextTermId(drawerSessions.length ? drawerSessions.map((row) => row.id) : cache.ids()));
  const killActiveOr = async (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await fetch(`${httpBase(serverIp, port)}/api/sessions/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(passwordRef.current) },
        body: JSON.stringify({ id }),
      });
    } catch {}
    cache.delete(id);
    disconnect(id);
    const remaining = drawerSessions.filter((row) => row.id !== id).map((row) => row.id);
    await refreshSessions();
    if (id === activeIdRef.current) {
      onClearPresentation();
      switchTo(remaining[0] ?? 'term-1');
    }
  };
  const resetForEndpointChange = () => {
    setHasConnected(false);
    disconnectAll();
    resetTerminal();
    connect(activeIdRef.current);
  };
  const refreshSocketActivity = () => {
    const now = Date.now();
    for (const state of connections.values()) if (state.open) state.lastSeen = now;
  };
  const markAuthFailed = () => setConnectionStatus('auth-failed');
  const restartActiveSession = () => connect(activeIdRef.current);
  const getActiveSessionId = () => activeIdRef.current;
  const getSessionEntry = (id: string) => cache.get(id);
  const getTerminalSelection = () => terminalSelectionRef.current;
  const setWindowFocused = (focused: boolean) => {
    windowFocusedRef.current = focused;
  };
  const isWindowFocused = () => windowFocusedRef.current;
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    void AsyncStorage.getItem(KEY_SESSION_ID).then((savedId) => {
      if (!savedId || savedId === activeIdRef.current) return;
      activeIdRef.current = savedId;
      setActiveId(savedId);
    });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: repaint is intentionally keyed to terminal view inputs.
  useEffect(() => {
    hydrateRenderer();
  }, [activeId, theme, fontFamily, fontSize]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: polling restarts when its connection inputs change.
  useEffect(() => {
    if (isConfiguring) return;
    const tick = () => {
      void refreshSessions();
    };
    tick();
    const interval = setInterval(tick, 4000);
    return () => clearInterval(interval);
  }, [isConfiguring, serverIp, port]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: connect reads endpoint and readiness refs at call time.
  useEffect(() => {
    if (!ready) return;
    connect(activeIdRef.current);
    return disconnectAll;
  }, [ready]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resume callbacks read current transport refs at event time.
  useEffect(() => {
    if (!ready) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      for (const [id, connection] of Array.from(connections))
        switch (resumeAction(connection, Date.now())) {
          case 'reconnect':
            connection.retry = 0;
            connect(id);
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
    connectionStatus,
    hasConnected,
    drawerSessions,
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
    resetForEndpointChange,
    restartActiveSession,
    markAuthFailed,
    refreshSocketActivity,
    setWindowFocused,
    isWindowFocused,
  };
}
