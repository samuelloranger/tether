import { useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { SessionActivity } from '../activity';
import type { DrawerSession } from '../SessionDrawer';
import type { TerminalViewHandle } from '../TerminalView.types';
import { OutputBatcher } from '../terminalRendererProtocol';
import type { HostClient } from './hostClient';
import type { HostHealth, HostHealthStatus } from './hostHealth';
import type { PollResult } from './hostPolling';
import type { HostProfile } from './hostStore';
import type { SessionHandoff } from './sessionTransport';
import { createSessionCache, sessionKey } from './terminalSessionLogic';
import type { ConnectionStatus, TerminalConnectionState } from './types';

function useSessionIdentity(client: HostClient) {
  const initialKey = sessionKey(client.profile.id, 'term-1');
  const [activeId, setActiveId] = useState('term-1');
  const activeIdRef = useRef('term-1');
  const [activeHostId, setActiveHostId] = useState(client.profile.id);
  const activeHostIdRef = useRef(client.profile.id);
  const activeKeyRef = useRef(initialKey);
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

function useSessionTransportRefs() {
  const disconnectRef = useRef<(key: string) => void>(() => {});
  const connectRef = useRef<(key: string) => void>(() => {});
  const cache = useRef(createSessionCache((key) => disconnectRef.current(key))).current;
  const connections = useRef(new Map<string, TerminalConnectionState>()).current;
  const healthRef = useRef(new Map<string, HostHealth>());
  const lastActivityRef = useRef(new Map<string, SessionActivity | null | undefined>());
  const notifyWaitingSessionsRef = useRef<(rows: DrawerSession[]) => void>(() => {});
  const updateHealthRef = useRef<(profile: HostProfile, result: PollResult) => void>(() => {});
  const terminalViewRef = useRef<TerminalViewHandle | null>(null);
  const terminalSelectionRef = useRef('');
  const dimsRef = useRef({ numCols: 80, numRows: 24 });
  const windowFocusedRef = useRef(true);
  const appStateRef = useRef(AppState.currentState);
  const handoffRef = useRef<SessionHandoff | null>(null);
  const switchGenRef = useRef(0);
  const adoptedHostsRef = useRef(new Set<string>());
  const probedHostsRef = useRef(new Set<string>());
  const themePaintReadyRef = useRef(false);
  return {
    disconnectRef,
    connectRef,
    cache,
    connections,
    healthRef,
    lastActivityRef,
    notifyWaitingSessionsRef,
    updateHealthRef,
    terminalViewRef,
    terminalSelectionRef,
    dimsRef,
    windowFocusedRef,
    appStateRef,
    handoffRef,
    switchGenRef,
    adoptedHostsRef,
    probedHostsRef,
    themePaintReadyRef,
  };
}

export function useTerminalSessionState(client: HostClient) {
  const identity = useSessionIdentity(client);
  const ui = useSessionUi();
  const refs = useSessionTransportRefs();
  const outputBatcherRef = useRef<OutputBatcher | null>(null);
  if (!outputBatcherRef.current) {
    outputBatcherRef.current = new OutputBatcher(
      () => identity.activeKeyRef.current,
      (data) => refs.terminalViewRef.current?.write(data),
      (flush) => requestAnimationFrame(flush),
    );
  }
  return { ...identity, ...ui, ...refs, outputBatcher: outputBatcherRef.current };
}

export type TerminalSessionState = ReturnType<typeof useTerminalSessionState>;
