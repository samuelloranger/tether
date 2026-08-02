import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { newlyWaiting, type SessionActivity } from '../activity';
import { writeClipboard } from '../clipboard';
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
import { applyPageControl, completeShadowHandoff, type PageControlEvent } from './pageControlState';
import {
  applyWsMessage,
  backoffDelay,
  createSessionCache,
  focusFrame,
  maybeNotify,
  parseSessionKey,
  retryAfterClose,
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
  theme: { terminal: { fg: string; bg: string }; keyboardAppearance: 'light' | 'dark' };
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
  const windowFocusedRef = useRef(true);
  const appStateRef = useRef(AppState.currentState);
  const clientRef = useRef(client);
  clientRef.current = client;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const disconnectRef = useRef<(key: string) => void>(() => {});
  const connectRef = useRef<(key: string) => void>(() => {});
  const cache = useRef(createSessionCache((key) => disconnectRef.current(key))).current;
  const connections = useRef(new Map<string, TerminalConnectionState>()).current;
  const lastActivityRef = useRef(new Map<string, SessionActivity | null | undefined>());
  const notifyWaitingSessionsRef = useRef<(rows: DrawerSession[]) => void>(() => {});
  const updateHealthRef = useRef<(profile: HostProfile, result: PollResult) => void>(() => {});
  const onReachableRef = useRef(onReachable);
  onReachableRef.current = onReachable;
  const outputBatcherRef = useRef<OutputBatcher | null>(null);
  if (!outputBatcherRef.current) {
    outputBatcherRef.current = new OutputBatcher(
      () => activeKeyRef.current,
      (data) => terminalViewRef.current?.write(data),
      (flush) => requestAnimationFrame(flush),
    );
  }
  const outputBatcher = outputBatcherRef.current;
  const handoffRef = useRef<{
    key: string;
    chunks: string[];
    /** When true, hold chunks off the page until hydrate finishes (theme repaint). */
    bufferOnly?: boolean;
  } | null>(null);
  const switchGenRef = useRef(0);

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
        openedAt: 0,
      };
      connections.set(key, state);
    }
    return state;
  };
  const entryForKey = (key: string): SessionEntry =>
    cache.touch(key, () => {
      const { numCols: cols, numRows: rows } = dimsRef.current;
      const term = new TerminalEngine(cols || 80, rows || 24);
      // The full xterm renderer owns user input and terminal-generated replies.
      // Headless xterm remains the background metadata/serialization model.
      term.onReply = null;
      term.onClipboardWrite = (text) => {
        // Background tabs stay live — an OSC 52 from a hidden session must not
        // silently overwrite the device clipboard while the user is elsewhere.
        if (key === activeKeyRef.current) void writeClipboard(text).catch(() => {});
      };
      return {
        term,
        sinceId: 0,
        lastAppliedId: 0,
        diffSummary: { files: [] },
        repoStatus: {
          branch: '',
          shortSha: '',
          detached: false,
          upstream: null,
          ahead: 0,
          behind: 0,
        },
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
  notifyWaitingSessionsRef.current = notifyWaitingSessions;
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
    void terminalViewRef.current?.hydrate(
      entry.term.serialize(),
      entry.term.cols,
      entry.term.rows,
      {
        foreground: theme.terminal.fg,
        background: theme.terminal.bg,
        keyboardAppearance: theme.keyboardAppearance,
      },
      fontFamily,
      fontSize,
      entry.term.getPromptLines(),
    );
  };
  /** Theme/font change while the page owns the buffer — re-seed from the live page. */
  const repaintActiveFromPage = () => {
    void (async () => {
      const key = activeKeyRef.current;
      const entry = cache.get(key);
      if (!entry) return;
      // Don't nest under an in-flight session-switch handoff.
      if (handoffRef.current) return;
      // Flush pending paints into the page so serialize includes them.
      outputBatcher.flushNow();
      const handoff = { key, chunks: [] as string[], bufferOnly: true };
      handoffRef.current = handoff;
      try {
        let data = entry.term.serialize();
        let promptLines = entry.term.getPromptLines();
        try {
          const live = await terminalViewRef.current?.serialize();
          if (live) {
            data = live.data;
            promptLines = live.promptLines;
          }
        } catch {
          // page unavailable — fall back to shadow
        }
        // Fold chunks that arrived during serialize into the hydrate payload.
        const trailing = handoff.chunks.splice(0, handoff.chunks.length);
        if (trailing.length) data += trailing.join('');
        if (key !== activeKeyRef.current) return;
        await terminalViewRef.current?.hydrate(
          data,
          entry.term.cols,
          entry.term.rows,
          {
            foreground: theme.terminal.fg,
            background: theme.terminal.bg,
            keyboardAppearance: theme.keyboardAppearance,
          },
          fontFamily,
          fontSize,
          promptLines,
        );
        // Drain anything that landed while hydrate was writing.
        while (handoff.chunks.length > 0) {
          const more = handoff.chunks.splice(0, handoff.chunks.length);
          terminalViewRef.current?.write(more.join(''));
        }
      } finally {
        if (handoffRef.current === handoff) handoffRef.current = null;
      }
    })();
  };
  // The renderer already coalesces its re-fit (see terminalFitCoalescer), so by
  // the time a resize reaches us the geometry has settled. Debouncing the PTY
  // half again would only re-open the window this event exists to close: the
  // local grid at the new size while the agent still patches the old one. Local
  // emulator and PTY move together, in this tick.
  const onRendererResize = (cols: number, rows: number) => {
    if (dimsRef.current.numCols === cols && dimsRef.current.numRows === rows) return;
    dimsRef.current = { numCols: cols, numRows: rows };
    cache.get(activeKeyRef.current)?.term.resize(cols, rows);
    wsSend({ type: 'resize', cols, rows });
  };
  const onRendererSelection = (text: string) => {
    terminalSelectionRef.current = text;
  };
  const onPageControl = (event: PageControlEvent) => {
    const key = activeKeyRef.current;
    const entry = cache.get(key);
    if (!entry) return;
    const effect = applyPageControl(entry, event);
    if (effect === 'metadata') setTerminalMetadataVersion((version) => version + 1);
    if (effect === 'notify') {
      const { sessionId, hostId } = parseSessionKey(key);
      maybeNotify({
        id: key,
        entry,
        activeId: activeKeyRef.current,
        windowFocused: windowFocusedRef.current,
        notificationsEnabled: notificationsEnabledRef.current,
        isDesktop,
        label: sessionLabel(
          drawerSessionsRef.current.find(
            (row) => row.id === sessionId && row.hostId === hostId,
          ) ?? {
            id: sessionId,
          },
        ),
        notify: (title, body) => void sendNativeNotification(title, body),
      });
    }
  };
  const onPageReply = (data: string) => {
    wsSend({ type: 'input', text: data });
  };
  const onPageClipboardWrite = (text: string) => {
    void writeClipboard(text).catch(() => {});
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
        onOutput: (sessionKey, chunk) => {
          const handoff = handoffRef.current;
          if (handoff && sessionKey === handoff.key) {
            handoff.chunks.push(chunk);
            // Theme repaint holds bytes off the page until hydrate finishes.
            if (handoff.bufferOnly) return;
          }
          outputBatcher.push(sessionKey, chunk);
        },
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
    // disconnect() drops the state object, so the escalating retry count has to
    // be carried across explicitly — otherwise every reconnect starts from 0
    // and backoff never engages.
    const carriedRetry = connections.get(key)?.retry ?? 0;
    disconnect(key);
    const { sessionId } = parseSessionKey(key);
    const entry = entryForKey(key);
    const state = connState(key);
    state.retry = carriedRetry;
    state.client = clientForKey(key);
    if (key === activeKeyRef.current) setConnectionStatus('connecting');
    const generation = ++state.gen;
    // A transport may invoke onOpen before openSocket returns, leaving
    // state.sock unassigned inside the handler. Send on a microtask, by which
    // point the assignment below has run.
    const reportFocus = (focused: boolean) =>
      queueMicrotask(() => {
        if (state.gen === generation) state.sock?.send(JSON.stringify(focusFrame(focused)));
      });
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
            // Opening is not proof of health — a socket killed mid-replay opens
            // too. retryAfterClose() clears the counter only once the connection
            // has stayed up, so a flapping socket keeps backing off.
            state.openedAt = Date.now();
            if (key === activeKeyRef.current) {
              setHasConnected(true);
              setConnectionStatus('connected');
              // A fresh connection is focused unless the app is known to be
              // backgrounded. AppState.currentState can be 'unknown' before the
              // first transition, and treating that as unfocused would silence
              // notifications for the session the user is looking at.
              reportFocus(
                appStateRef.current !== 'background' && appStateRef.current !== 'inactive',
              );
            } else reportFocus(false);
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
            state.retry = retryAfterClose(state, Date.now());
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
  // Read at call time so the polling effect does not depend on a new closure
  // every render (same pattern as disconnectRef above).
  connectRef.current = connect;
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
  updateHealthRef.current = updateHealth;
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
    const gen = ++switchGenRef.current;
    void (async () => {
      // Serialize the leaving page into its shadow before hydrating the next
      // session — the page is the only live parser while a tab is active.
      if (previousKey !== targetKey && cache.has(previousKey)) {
        const handoff = { key: previousKey, chunks: [] as string[] };
        handoffRef.current = handoff;
        try {
          const previous = cache.get(previousKey);
          if (previous) {
            await completeShadowHandoff({
              term: previous.term,
              handoff,
              serialize: () => {
                const view = terminalViewRef.current;
                if (!view) return Promise.reject(new Error('terminal view unavailable'));
                return view.serialize();
              },
              isAvailable: () => terminalViewRef.current != null,
              entry: previous,
            });
          }
        } catch (error) {
          console.warn('shadow handoff: unexpected failure', error);
        } finally {
          // Keep handoff live through seed so mid-seed WS chunks stay captured;
          // only drop it once the shadow is fully seeded (or we gave up).
          if (handoffRef.current === handoff) handoffRef.current = null;
        }
      }
      if (gen !== switchGenRef.current) return;
      sendFocus(false);
      // The user picked this session explicitly, so the host is adopted. Without
      // this, the host's next poll would run the adoption branch and reconnect —
      // disconnecting the socket that was just opened.
      adoptedHostsRef.current.add(hostId);
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
    })();
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
  // A host's first connect waits for its session list. Opening a socket for a
  // session id the server does not know *creates* it (app.ts startSession), so
  // connecting to the default `term-1` before the list arrives spawns a stray
  // terminal on every newly added host.
  const adoptedHostsRef = useRef(new Set<string>());
  // Hosts we opened a socket for purely to show a failed connection state.
  const probedHostsRef = useRef(new Set<string>());
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: session switches hydrate from the shadow.
  useEffect(() => {
    hydrateRenderer();
  }, [activeId, activeHostId]);
  const themePaintReadyRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme/font repaint from the live page buffer.
  useEffect(() => {
    // Skip the initial mount — activeId effect hydrates from the shadow. Later
    // theme/font changes must read the live page (shadow is stale while active).
    if (!themePaintReadyRef.current) {
      themePaintReadyRef.current = true;
      return;
    }
    repaintActiveFromPage();
  }, [theme, fontFamily, fontSize]);
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
        if (profile.id === activeHostIdRef.current) notifyWaitingSessionsRef.current(rows);
        if (profile.id === activeHostIdRef.current && !adoptedHostsRef.current.has(profile.id)) {
          adoptedHostsRef.current.add(profile.id);
          // Adopt the most recent live session rather than creating another one.
          // Only a host with no sessions at all gets a fresh `term-1`.
          const running = rows.filter((row) => row.status === 'running');
          if (running.length && !running.some((row) => row.id === activeIdRef.current)) {
            const newest = [...running].sort((a, b) =>
              (b.last_output_at ?? '').localeCompare(a.last_output_at ?? ''),
            )[0];
            activeIdRef.current = newest.id;
            activeKeyRef.current = sessionKey(profile.id, newest.id);
            setActiveId(newest.id);
            void AsyncStorage.setItem(activeSessionStorageKey(profile.id), newest.id);
          }
          if (readyRef.current) connectRef.current(activeKeyRef.current);
        }
      },
      onHealth: (profile, result) => {
        updateHealthRef.current(profile, result);
        if (result === 'success') {
          void onReachableRef.current?.(profile);
          return;
        }
        // The host answered with a failure, so there is no session list coming.
        // Open the socket to surface the real connection state — but do NOT mark
        // the host adopted: if it later recovers, its list must still be able to
        // adopt an existing session instead of leaving us on the default id.
        if (
          profile.id === activeHostIdRef.current &&
          !adoptedHostsRef.current.has(profile.id) &&
          !probedHostsRef.current.has(profile.id) &&
          readyRef.current
        ) {
          probedHostsRef.current.add(profile.id);
          connectRef.current(activeKeyRef.current);
        }
      },
    });
    void polling.start().catch(() => {});
    return polling.stop;
  }, [clientFor, isConfiguring, profiles]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: connect reads the current client ref at call time.
  useEffect(() => {
    if (!ready) return;
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
    onPageControl,
    onPageReply,
    onPageClipboardWrite,
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
