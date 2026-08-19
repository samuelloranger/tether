import { useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { SessionActivity } from '../activity';
import { newlyWaiting } from '../activity';
import { notify as sendNativeNotification } from '../desktopNotify';
import { isDesktop } from '../platform';
import type { DrawerSession } from '../SessionDrawer';
import { sessionLabel } from '../sessionLabel';
import type { TerminalViewHandle } from '../TerminalView.types';
import { OutputBatcher } from '../terminalRendererProtocol';
import type { HostClient } from './hostClient';
import type { HostHealth, HostHealthStatus } from './hostHealth';
import type { PollResult } from './hostPolling';
import type { HostProfile } from './hostStore';
import { applyHostHealth, type TerminalSessionsOptions } from './sessionHostOps';
import {
  connectSession,
  disconnectAllSessions,
  disconnectSession,
  type SessionHandoff,
  type SessionTransportBag,
} from './sessionTransport';
import { createSessionCache, sessionKey } from './terminalSessionLogic';
import type { ConnectionStatus, TerminalConnectionState } from './types';

// The session runtime owns every piece of mutable session state and the
// transport bound to it. Keeping the two together is deliberate: the transport
// bag is a *view* of this state, so building it here means there is one source
// of truth rather than a state object plus a hand-maintained copy of its fields.
// It also removes the late-bound refs a state/action split would otherwise need
// — connect, disconnect, notifyWaiting and updateHealth can all be defined the
// moment the state they read exists.

function useSessionIdentity(client: HostClient) {
  const [activeId, setActiveId] = useState('term-1');
  const activeIdRef = useRef('term-1');
  const [activeHostId, setActiveHostId] = useState(client.profile.id);
  const activeHostIdRef = useRef(client.profile.id);
  const activeKeyRef = useRef(sessionKey(client.profile.id, 'term-1'));
  const clientRef = useRef(client);
  clientRef.current = client;
  return {
    activeId,
    setActiveId,
    activeIdRef,
    activeHostId,
    setActiveHostId,
    activeHostIdRef,
    activeKeyRef,
    clientRef,
  };
}

function useSessionUi() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const connectionStatusRef = useRef(connectionStatus);
  connectionStatusRef.current = connectionStatus;
  const [hasConnected, setHasConnected] = useState(false);
  const [drawerSessions, setDrawerSessions] = useState<DrawerSession[]>([]);
  const drawerSessionsRef = useRef(drawerSessions);
  drawerSessionsRef.current = drawerSessions;
  const [healthByHost, setHealthByHost] = useState<Record<string, HostHealthStatus>>({});
  const [_terminalMetadataVersion, setTerminalMetadataVersion] = useState(0);
  const [_gitSummaryVersion, setGitSummaryVersion] = useState(0);
  return {
    connectionStatus,
    setConnectionStatus,
    connectionStatusRef,
    hasConnected,
    setHasConnected,
    drawerSessions,
    setDrawerSessions,
    drawerSessionsRef,
    healthByHost,
    setHealthByHost,
    setTerminalMetadataVersion,
    setGitSummaryVersion,
  };
}

// Refs the transport itself never reads — coordination state for the effects and
// the host layer. Kept apart from the transport bag so the bag stays the narrow
// interface the transport functions actually depend on.
function useCoordinationRefs() {
  const healthRef = useRef(new Map<string, HostHealth>());
  const lastActivityRef = useRef(new Map<string, SessionActivity | null | undefined>());
  const terminalSelectionRef = useRef('');
  const switchGenRef = useRef(0);
  const adoptedHostsRef = useRef(new Set<string>());
  const probedHostsRef = useRef(new Set<string>());
  const themePaintReadyRef = useRef(false);
  return {
    healthRef,
    lastActivityRef,
    terminalSelectionRef,
    switchGenRef,
    adoptedHostsRef,
    probedHostsRef,
    themePaintReadyRef,
  };
}

// Live view/environment state the transport reads on every frame. Grouped
// because they share one lifetime and one consumer, not to hit a line count.
function useTransportRefs(ready: boolean, getActiveKey: () => string) {
  const terminalViewRef = useRef<TerminalViewHandle | null>(null);
  const dimsRef = useRef({ numCols: 80, numRows: 24 });
  const windowFocusedRef = useRef(true);
  const appStateRef = useRef(AppState.currentState);
  const handoffRef = useRef<SessionHandoff | null>(null);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const outputBatcherRef = useRef<OutputBatcher | null>(null);
  if (!outputBatcherRef.current) {
    outputBatcherRef.current = new OutputBatcher(
      getActiveKey,
      (data) => terminalViewRef.current?.write(data),
      (flush) => requestAnimationFrame(flush),
    );
  }
  return {
    terminalViewRef,
    dimsRef,
    windowFocusedRef,
    appStateRef,
    handoffRef,
    readyRef,
    outputBatcher: outputBatcherRef.current,
  };
}

export function useSessionRuntime(opts: TerminalSessionsOptions) {
  const identity = useSessionIdentity(opts.client);
  const ui = useSessionUi();
  const coordination = useCoordinationRefs();
  const view = useTransportRefs(opts.ready, () => identity.activeKeyRef.current);

  // The cache evicts by disconnecting, but disconnect needs the bag, which needs
  // the cache. This one indirection is a genuine cycle, not a split artifact.
  const disconnectRef = useRef<(key: string) => void>(() => {});
  const cache = useRef(createSessionCache((key) => disconnectRef.current(key))).current;
  const connections = useRef(new Map<string, TerminalConnectionState>()).current;

  const notifyWaiting = (rows: DrawerSession[]) => {
    const alerts = newlyWaiting(
      coordination.lastActivityRef.current,
      rows,
      identity.activeIdRef.current,
    );
    for (const row of rows) coordination.lastActivityRef.current.set(row.id, row.activity);
    if (!isDesktop) return;
    for (const row of alerts)
      void sendNativeNotification(sessionLabel(row), 'Session is waiting for your input');
  };

  const transport: SessionTransportBag = {
    ...view,
    connections,
    cache,
    clientRef: identity.clientRef,
    profiles: opts.profiles,
    clientFor: opts.clientFor,
    activeKeyRef: identity.activeKeyRef,
    connectionStatusRef: ui.connectionStatusRef,
    notificationsEnabledRef: opts.notificationsEnabledRef,
    drawerSessionsRef: ui.drawerSessionsRef,
    setConnectionStatus: ui.setConnectionStatus,
    setHasConnected: ui.setHasConnected,
    setGitSummaryVersion: ui.setGitSummaryVersion,
    setTerminalMetadataVersion: ui.setTerminalMetadataVersion,
    setDrawerSessions: ui.setDrawerSessions,
    notifyWaitingSessions: notifyWaiting,
    theme: opts.theme,
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize,
  };

  const connect = (key: string) => connectSession(transport, key);
  const disconnect = (key: string) => disconnectSession(transport, key);
  disconnectRef.current = disconnect;

  return {
    ...identity,
    ...ui,
    ...coordination,
    ...view,
    cache,
    connections,
    transport,
    connect,
    disconnect,
    disconnectAll: () => disconnectAllSessions(transport),
    connectActive: () => connect(identity.activeKeyRef.current),
    notifyWaiting,
    updateHealth: (profile: HostProfile, result: PollResult) =>
      applyHostHealth(coordination.healthRef.current, profile, result, ui.setHealthByHost),
  };
}

export type SessionRuntime = ReturnType<typeof useSessionRuntime>;
