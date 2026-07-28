// biome-ignore-all lint/correctness/useExhaustiveDependencies: transport callbacks intentionally retain stable session refs.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { newlyWaiting, type SessionActivity } from '../activity';
import { httpBase, wsUrl } from '../address';
import { notify as sendNativeNotification } from '../desktopNotify';
import { isDesktop } from '../platform';
import { resumeAction } from '../resume';
import type { DrawerSession } from '../SessionDrawer';
import { authHeaders } from '../secureConfig';
import { nextTermId, SessionCache, type SessionEntry } from '../sessionCache';
import { sessionLabel } from '../sessionLabel';
import type { TerminalViewHandle } from '../TerminalView.types';
import { TerminalEngine } from '../terminalEngine';
import { OutputBatcher } from '../terminalRendererProtocol';
import { openTerminalSocket } from '../wsTransport';
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
  const hasConnectedRef = useRef(false);
  const [drawerSessions, setDrawerSessions] = useState<DrawerSession[]>([]);
  const [terminalMetadataVersion, setTerminalMetadataVersion] = useState(0);
  const [gitSummaryVersion, setGitSummaryVersion] = useState(0);
  const terminalViewRef = useRef<TerminalViewHandle | null>(null);
  const terminalSelectionRef = useRef('');
  const dimsRef = useRef({ numCols: 80, numRows: 24 });
  const rendererResizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowFocusedRef = useRef(true);
  const disconnectRef = useRef<(id: string) => void>(() => {});
  const cache = useRef(new SessionCache(3, (id) => disconnectRef.current(id))).current;
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
  const backoffDelay = (attempt: number) => {
    const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    return base / 2 + Math.floor(Math.random() * (base / 2));
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
  const maybeNotify = (id: string, entry: SessionEntry) => {
    if (!isDesktop || !notificationsEnabledRef.current) return;
    const gated = id === activeIdRef.current && windowFocusedRef.current;
    const notifyFired = entry.term.notifyCount > entry.lastNotifyCount;
    const bellFired = entry.term.bellCount > entry.lastBellCount;
    entry.lastNotifyCount = entry.term.notifyCount;
    entry.lastBellCount = entry.term.bellCount;
    if (gated || (!notifyFired && !bellFired)) return;
    const label = sessionLabel(drawerSessions.find((row) => row.id === id) ?? { id });
    if (notifyFired) {
      const { title, body } = entry.term.lastNotify;
      void sendNativeNotification(title || label, body || 'Needs your input');
    } else void sendNativeNotification(label, 'Terminal bell');
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
  const applyWsMessage = (id: string, data: string) => {
    try {
      const message = JSON.parse(data);
      const entry = cache.get(id);
      if (!entry) return;
      if (message.type === 'diff' && Array.isArray(message.summary?.files)) {
        entry.diffSummary = { files: message.summary.files };
        if (id === activeIdRef.current) setGitSummaryVersion((version) => version + 1);
      } else if (message.type === 'output') {
        if (typeof message.id !== 'number' || message.id <= entry.lastAppliedId) return;
        entry.lastAppliedId = message.id;
        entry.sinceId = message.id;
        const previous = [
          entry.term.bellCount,
          entry.term.promptReturnCount,
          entry.term.title,
          entry.term.cwd,
        ] as const;
        entry.term.write(message.chunk, () => {
          maybeNotify(id, entry);
          if (
            id === activeIdRef.current &&
            (entry.term.bellCount !== previous[0] ||
              entry.term.promptReturnCount !== previous[1] ||
              entry.term.title !== previous[2] ||
              entry.term.cwd !== previous[3])
          )
            setTerminalMetadataVersion((version) => version + 1);
          outputBatcher.push(id, message.chunk);
        });
      } else if (message.type === 'exit') {
        const code = typeof message.exitCode === 'number' ? ` with code ${message.exitCode}` : '';
        const text = `\r\n\x1b[31m[Process exited${code}]\x1b[0m\r\n`;
        entry.term.write(text, () => outputBatcher.push(id, text));
      } else if (message.type === 'title' && typeof message.title === 'string') {
        setDrawerSessions((previous) =>
          previous.map((row) => (row.id === id ? { ...row, auto_title: message.title } : row)),
        );
      } else if (message.type === 'activity') {
        const activity = message.activity as SessionActivity;
        setDrawerSessions((previous) =>
          previous.map((row) => (row.id === id ? { ...row, activity } : row)),
        );
        notifyWaitingSessions([{ id, status: 'running', last_output_at: null, activity }]);
      } else if (message.type === 'reset') {
        entry.term.reset();
        entry.sinceId = 0;
        entry.lastAppliedId = 0;
        entry.lastBellCount = 0;
        entry.lastNotifyCount = 0;
        if (id === activeIdRef.current) hydrateRenderer(id);
      }
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
    lastConnectedRef.current = { ip: serverIp, port };
    const entry = entryFor(id),
      state = connState(id);
    if (id === activeIdRef.current) setConnectionStatus('connecting');
    const generation = ++state.gen;
    const fresh = () => generation === state.gen;
    state.sock = openTerminalSocket(
      wsUrl(serverIp, port, {
        sessionId: id,
        sinceId: entry.sinceId,
        cols: dimsRef.current.numCols,
        rows: dimsRef.current.numRows,
      }),
      passwordRef.current,
      {
        onOpen: () => {
          if (!fresh()) return;
          state.open = true;
          state.retry = 0;
          if (id === activeIdRef.current) {
            hasConnectedRef.current = true;
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
        },
        onMessage: (data) => {
          state.lastSeen = Date.now();
          if (fresh()) applyWsMessage(id, data);
        },
        onClose: () => {
          if (!fresh()) return;
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
          if (ready && cache.has(id))
            state.reconnectTimeout = setTimeout(() => connect(id), backoffDelay(state.retry++));
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
    hasConnectedRef.current = false;
    disconnectAll();
    resetTerminal();
    connect(activeIdRef.current);
  };
  const refreshSocketActivity = () => {
    const now = Date.now();
    for (const state of connections.values()) if (state.open) state.lastSeen = now;
  };
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
  useEffect(() => {
    hydrateRenderer();
  }, [activeId, theme, fontFamily, fontSize]);
  useEffect(() => {
    if (isConfiguring) return;
    const tick = () => {
      void refreshSessions();
    };
    tick();
    const interval = setInterval(tick, 4000);
    return () => clearInterval(interval);
  }, [isConfiguring, serverIp, port]);
  useEffect(() => {
    if (!ready) return;
    connect(activeIdRef.current);
    return disconnectAll;
  }, [ready]);
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
  useEffect(
    () => () => {
      disconnectAll();
      outputBatcher.clear();
      if (rendererResizeTimer.current) clearTimeout(rendererResizeTimer.current);
    },
    [],
  );

  return {
    cache,
    activeId,
    setActiveId,
    activeIdRef,
    connectionStatus,
    setConnectionStatus,
    hasConnectedRef,
    drawerSessions,
    setDrawerSessions,
    terminalMetadataVersion,
    gitSummaryVersion,
    terminalViewRef,
    terminalSelectionRef,
    entryFor,
    wsSend,
    hydrateRenderer,
    onRendererResize,
    onRendererSelection,
    resetTerminal,
    applyWsMessage,
    connect,
    disconnect,
    disconnectAll,
    switchTo,
    newTerminal,
    killActiveOr,
    refreshSessions,
    resetForEndpointChange,
    refreshSocketActivity,
    windowFocusedRef,
  };
}
