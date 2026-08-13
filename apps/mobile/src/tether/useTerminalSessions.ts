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
import { OutputBatcher } from '../terminalRendererProtocol';
import { type HostHealth, type HostHealthStatus, initialHostHealth } from './hostHealth';
import { createHostPolling, type PollResult } from './hostPolling';
import type { HostProfile } from './hostStore';
import type { PageControlEvent } from './pageControlState';
import {
  applyHostHealth,
  dropHostSessions,
  killActiveSession,
  refreshHostSessionList,
  type TerminalSessionsOptions,
} from './sessionHostOps';
import { applyPolledSessions, probeUnreachableActiveHost } from './sessionPolling';
import { nextIdsForHost, restoreSavedActiveId, switchActiveSession } from './sessionSwitch';
import {
  applyRendererResize,
  cachedEntry,
  connectSession,
  disconnectAllSessions,
  disconnectSession,
  handlePageControl,
  hydrateRenderer,
  repaintActiveFromPage,
  resolveClientForKey,
  type SessionHandoff,
  type SessionTransportBag,
  sendActiveJson,
  sendFocus,
} from './sessionTransport';
import { createSessionCache, parseSessionKey, sessionKey } from './terminalSessionLogic';
import type { ConnectionStatus, TerminalConnectionState } from './types';

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
}: TerminalSessionsOptions) {
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
  const handoffRef = useRef<SessionHandoff | null>(null);
  const switchGenRef = useRef(0);
  const adoptedHostsRef = useRef(new Set<string>());
  const probedHostsRef = useRef(new Set<string>());
  const notifyWaitingSessions = (rows: DrawerSession[]) => {
    const alerts = newlyWaiting(lastActivityRef.current, rows, activeIdRef.current);
    for (const row of rows) lastActivityRef.current.set(row.id, row.activity);
    if (!isDesktop) return;
    for (const row of alerts)
      void sendNativeNotification(sessionLabel(row), 'Session is waiting for your input');
  };
  notifyWaitingSessionsRef.current = notifyWaitingSessions;
  const bag: SessionTransportBag = {
    connections,
    cache,
    clientRef,
    profiles,
    clientFor,
    activeKeyRef,
    dimsRef,
    readyRef,
    connectionStatusRef,
    windowFocusedRef,
    notificationsEnabledRef,
    drawerSessionsRef,
    appStateRef,
    handoffRef,
    terminalViewRef,
    outputBatcher,
    setConnectionStatus,
    setHasConnected,
    setGitSummaryVersion,
    setTerminalMetadataVersion,
    setDrawerSessions,
    notifyWaitingSessions,
    theme,
    fontFamily,
    fontSize,
  };
  const entryFor = (id: string): SessionEntry =>
    cachedEntry(bag, sessionKey(activeHostIdRef.current, id));
  const wsSend = (object: unknown) => sendActiveJson(bag, object);
  const hydrate = (key = activeKeyRef.current) => hydrateRenderer(bag, key);
  const disconnect = (key: string) => disconnectSession(bag, key);
  const disconnectAll = () => disconnectAllSessions(bag);
  const connect = (key: string) => connectSession(bag, key);
  disconnectRef.current = disconnect;
  connectRef.current = connect;
  const onRendererResize = (cols: number, rows: number) => applyRendererResize(bag, cols, rows);
  const onRendererSelection = (text: string) => {
    terminalSelectionRef.current = text;
  };
  const onPageControl = (event: PageControlEvent) =>
    handlePageControl(bag, event, () => setTerminalMetadataVersion((version) => version + 1));
  const onPageReply = (data: string) => wsSend({ type: 'input', text: data });
  const onPageClipboardWrite = (text: string) => {
    void writeClipboard(text).catch(() => {});
  };
  const resetTerminal = () => {
    const entry = cache.get(activeKeyRef.current);
    if (!entry) return;
    entry.term.reset();
    entry.sinceId = 0;
    entry.lastAppliedId = 0;
    hydrate();
  };

  const updateHealth = (profile: HostProfile, result: PollResult) => {
    applyHostHealth(healthRef.current, profile, result, setHealthByHost);
  };
  updateHealthRef.current = updateHealth;
  const refreshSessionsFor = (profile: HostProfile) =>
    refreshHostSessionList({
      profile,
      client: clientFor(profile),
      activeHostId: activeHostIdRef.current,
      setConnectionStatus,
      setDrawerSessions,
      notifyWaiting: notifyWaitingSessions,
      updateHealth,
    });
  const refreshSessions = async () => {
    const profile =
      profiles.find((candidate) => candidate.id === activeHostIdRef.current) ??
      clientRef.current.profile;
    await refreshSessionsFor(profile);
  };
  const switchTo = (hostId: string, id: string) => {
    void switchActiveSession({
      hostId,
      id,
      bag,
      cache,
      connections,
      activeKeyRef,
      activeHostIdRef,
      activeIdRef,
      switchGenRef,
      adoptedHosts: adoptedHostsRef.current,
      terminalViewRef,
      setActiveHostId,
      setActiveId,
      setConnectionStatus,
      hydrate,
      connect,
      onCloseDrawer,
      onClearView,
    });
  };
  const newTerminal = () => {
    const hostId = activeHostIdRef.current;
    switchTo(hostId, nextTermId(nextIdsForHost(hostId, drawerSessions, cache, parseSessionKey)));
  };
  const killActiveOr = (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    return killActiveSession({
      id,
      hostId: activeHostIdRef.current,
      activeKey: activeKeyRef.current,
      client: clientRef.current,
      cache,
      drawerSessions,
      disconnect,
      refreshSessions,
      onClearPresentation,
      switchTo,
    });
  };

  useEffect(() => {
    restoreSavedActiveId({
      hostId: client.profile.id,
      activeHostIdRef,
      activeIdRef,
      activeKeyRef,
      setActiveHostId,
      setActiveId,
    });
  }, [client.profile.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: session switches hydrate from the shadow.
  useEffect(() => {
    hydrate();
  }, [activeId, activeHostId]);
  const themePaintReadyRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme/font repaint from the live page buffer.
  useEffect(() => {
    if (!themePaintReadyRef.current) {
      themePaintReadyRef.current = true;
      return;
    }
    void repaintActiveFromPage(bag);
  }, [theme, fontFamily, fontSize]);
  useEffect(() => {
    if (isConfiguring || profiles.length === 0) return;
    const polling = createHostPolling({
      getProfiles: () => profiles,
      getActiveHostId: () => activeHostIdRef.current,
      getHealth: (profile) => healthRef.current.get(profile.id) ?? initialHostHealth(),
      clientFor,
      onSessions: (profile, sessions) =>
        applyPolledSessions({
          profile,
          sessions,
          activeHostId: activeHostIdRef.current,
          activeIdRef,
          activeKeyRef,
          adoptedHosts: adoptedHostsRef.current,
          ready: readyRef.current,
          setDrawerSessions,
          setActiveId,
          notifyWaiting: notifyWaitingSessionsRef.current,
          connectActive: () => connectRef.current(activeKeyRef.current),
        }),
      onHealth: (profile, result) => {
        updateHealthRef.current(profile, result);
        if (result === 'success') {
          void onReachableRef.current?.(profile);
          return;
        }
        probeUnreachableActiveHost({
          profile,
          activeHostId: activeHostIdRef.current,
          adoptedHosts: adoptedHostsRef.current,
          probedHosts: probedHostsRef.current,
          ready: readyRef.current,
          connectActive: () => connectRef.current(activeKeyRef.current),
        });
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
    sendFocus(bag, true);
    const subscription = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
      if (state === 'background' || state === 'inactive') {
        sendFocus(bag, false);
        return;
      }
      if (state !== 'active') return;
      sendFocus(bag, true);
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
    activeClient: resolveClientForKey(bag, activeKeyRef.current),
    connectionStatus,
    hasConnected,
    drawerSessions,
    healthByHost,
    terminalViewRef,
    entryFor,
    getSessionEntry: (id: string) => cache.get(sessionKey(activeHostIdRef.current, id)),
    getActiveSessionId: () => activeIdRef.current,
    getTerminalSelection: () => terminalSelectionRef.current,
    wsSend,
    hydrateRenderer: hydrate,
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
    removeHost: (hostId: string) =>
      dropHostSessions({
        hostId,
        connections,
        cache,
        disconnect,
        setDrawerSessions,
        setHealthByHost,
      }),
    resetForEndpointChange: () => {
      setHasConnected(false);
      disconnectAll();
      resetTerminal();
      connect(activeKeyRef.current);
    },
    restartActiveSession: () => connect(activeKeyRef.current),
    markAuthFailed: () => setConnectionStatus('auth-failed'),
    refreshSocketActivity: () => {
      const now = Date.now();
      for (const state of connections.values()) if (state.open) state.lastSeen = now;
    },
    setWindowFocused: (focused: boolean) => {
      windowFocusedRef.current = focused;
    },
    isWindowFocused: () => windowFocusedRef.current,
  };
}
