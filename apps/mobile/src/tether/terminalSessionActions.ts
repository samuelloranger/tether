import * as Haptics from 'expo-haptics';
import { newlyWaiting } from '../activity';
import { writeClipboard } from '../clipboard';
import { notify as sendNativeNotification } from '../desktopNotify';
import { isDesktop } from '../platform';
import type { DrawerSession } from '../SessionDrawer';
import { nextTermId } from '../sessionCache';
import { sessionLabel } from '../sessionLabel';
import { initialHostHealth } from './hostHealth';
import type { PageControlEvent } from './pageControlState';
import {
  applyHostHealth,
  dropHostSessions,
  killActiveSession,
  refreshHostSessionList,
  type TerminalSessionsOptions,
} from './sessionHostOps';
import { nextIdsForHost, switchActiveSession } from './sessionSwitch';
import {
  applyRendererResize,
  cachedEntry,
  connectSession,
  disconnectAllSessions,
  disconnectSession,
  handlePageControl,
  hydrateRenderer,
  type SessionTransportBag,
  sendActiveJson,
} from './sessionTransport';
import { parseSessionKey, sessionKey } from './terminalSessionLogic';
import type { TerminalSessionState } from './terminalSessionState';

export function notifyWaitingSessions(state: TerminalSessionState, rows: DrawerSession[]) {
  const alerts = newlyWaiting(state.lastActivityRef.current, rows, state.activeIdRef.current);
  for (const row of rows) state.lastActivityRef.current.set(row.id, row.activity);
  if (!isDesktop) return;
  for (const row of alerts)
    void sendNativeNotification(sessionLabel(row), 'Session is waiting for your input');
}

export function buildTransportBag(
  opts: TerminalSessionsOptions,
  state: TerminalSessionState,
  readyRef: { current: boolean },
): SessionTransportBag {
  return {
    connections: state.connections,
    cache: state.cache,
    clientRef: state.clientRef,
    profiles: opts.profiles,
    clientFor: opts.clientFor,
    activeKeyRef: state.activeKeyRef,
    dimsRef: state.dimsRef,
    readyRef,
    connectionStatusRef: state.connectionStatusRef,
    windowFocusedRef: state.windowFocusedRef,
    notificationsEnabledRef: opts.notificationsEnabledRef,
    drawerSessionsRef: state.drawerSessionsRef,
    appStateRef: state.appStateRef,
    handoffRef: state.handoffRef,
    terminalViewRef: state.terminalViewRef,
    outputBatcher: state.outputBatcher,
    setConnectionStatus: state.setConnectionStatus,
    setHasConnected: state.setHasConnected,
    setGitSummaryVersion: state.setGitSummaryVersion,
    setTerminalMetadataVersion: state.setTerminalMetadataVersion,
    setDrawerSessions: state.setDrawerSessions,
    notifyWaitingSessions: (rows) => notifyWaitingSessions(state, rows),
    theme: opts.theme,
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize,
  };
}

function bindHostActions(
  opts: TerminalSessionsOptions,
  state: TerminalSessionState,
  bag: SessionTransportBag,
  connect: (key: string) => void,
) {
  const hydrate = (key = state.activeKeyRef.current) => hydrateRenderer(bag, key);
  const updateHealth = (
    profile: Parameters<typeof applyHostHealth>[1],
    result: Parameters<typeof applyHostHealth>[2],
  ) => applyHostHealth(state.healthRef.current, profile, result, state.setHealthByHost);
  const refreshSessionsFor = (profile: Parameters<typeof refreshHostSessionList>[0]['profile']) =>
    refreshHostSessionList({
      profile,
      client: opts.clientFor(profile),
      activeHostId: state.activeHostIdRef.current,
      setConnectionStatus: state.setConnectionStatus,
      setDrawerSessions: state.setDrawerSessions,
      notifyWaiting: (rows) => notifyWaitingSessions(state, rows),
      updateHealth,
    });
  const refreshSessions = async () => {
    const profile =
      opts.profiles.find((candidate) => candidate.id === state.activeHostIdRef.current) ??
      state.clientRef.current.profile;
    await refreshSessionsFor(profile);
  };
  const switchTo = (hostId: string, id: string) => {
    void switchActiveSession({
      hostId,
      id,
      bag,
      cache: state.cache,
      connections: state.connections,
      activeKeyRef: state.activeKeyRef,
      activeHostIdRef: state.activeHostIdRef,
      activeIdRef: state.activeIdRef,
      switchGenRef: state.switchGenRef,
      adoptedHosts: state.adoptedHostsRef.current,
      terminalViewRef: state.terminalViewRef,
      setActiveHostId: state.setActiveHostId,
      setActiveId: state.setActiveId,
      setConnectionStatus: state.setConnectionStatus,
      hydrate,
      connect,
      onCloseDrawer: opts.onCloseDrawer,
      onClearView: opts.onClearView,
    });
  };
  return { hydrate, updateHealth, refreshSessionsFor, refreshSessions, switchTo };
}

export function createSessionActions(
  opts: TerminalSessionsOptions,
  state: TerminalSessionState,
  bag: SessionTransportBag,
) {
  const disconnect = (key: string) => disconnectSession(bag, key);
  const disconnectAll = () => disconnectAllSessions(bag);
  const connect = (key: string) => connectSession(bag, key);
  state.disconnectRef.current = disconnect;
  state.connectRef.current = connect;
  const host = bindHostActions(opts, state, bag, connect);
  const resetTerminal = () => {
    const entry = state.cache.get(state.activeKeyRef.current);
    if (!entry) return;
    entry.term.reset();
    entry.sinceId = 0;
    entry.lastAppliedId = 0;
    host.hydrate();
  };
  const newTerminal = () => {
    const hostId = state.activeHostIdRef.current;
    host.switchTo(
      hostId,
      nextTermId(nextIdsForHost(hostId, state.drawerSessions, state.cache, parseSessionKey)),
    );
  };
  const killActiveOr = (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    return killActiveSession({
      id,
      hostId: state.activeHostIdRef.current,
      activeKey: state.activeKeyRef.current,
      client: state.clientRef.current,
      cache: state.cache,
      drawerSessions: state.drawerSessions,
      disconnect,
      refreshSessions: host.refreshSessions,
      onClearPresentation: opts.onClearPresentation,
      switchTo: host.switchTo,
    });
  };
  return {
    bag,
    connect,
    disconnect,
    disconnectAll,
    resetTerminal,
    newTerminal,
    killActiveOr,
    entryFor: (id: string) => cachedEntry(bag, sessionKey(state.activeHostIdRef.current, id)),
    wsSend: (object: unknown) => sendActiveJson(bag, object),
    onRendererResize: (cols: number, rows: number) => applyRendererResize(bag, cols, rows),
    onRendererSelection: (text: string) => {
      state.terminalSelectionRef.current = text;
    },
    onPageControl: (event: PageControlEvent) =>
      handlePageControl(bag, event, () =>
        state.setTerminalMetadataVersion((version) => version + 1),
      ),
    onPageClipboardWrite: (text: string) => {
      void writeClipboard(text).catch(() => {});
    },
    ...host,
  };
}

export type SessionActions = ReturnType<typeof createSessionActions>;

export function sessionHostMutations(
  opts: TerminalSessionsOptions,
  state: TerminalSessionState,
  actions: SessionActions,
) {
  return {
    refreshHost: (hostId: string) => {
      const profile = opts.profiles.find((candidate) => candidate.id === hostId);
      if (profile) void actions.refreshSessionsFor(profile);
    },
    resetHostHealth: (hostId: string) => {
      state.healthRef.current.set(hostId, initialHostHealth());
      state.setHealthByHost((previous) => ({ ...previous, [hostId]: 'unknown' }));
    },
    removeHost: (hostId: string) =>
      dropHostSessions({
        hostId,
        connections: state.connections,
        cache: state.cache,
        disconnect: actions.disconnect,
        setDrawerSessions: state.setDrawerSessions,
        setHealthByHost: state.setHealthByHost,
      }),
    resetForEndpointChange: () => {
      state.setHasConnected(false);
      actions.disconnectAll();
      actions.resetTerminal();
      actions.connect(state.activeKeyRef.current);
    },
  };
}
