import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { resumeAction } from '../resume';
import { initialHostHealth } from './hostHealth';
import { createHostPolling } from './hostPolling';
import type { TerminalSessionsOptions } from './sessionHostOps';
import { applyPolledSessions, probeUnreachableActiveHost } from './sessionPolling';
import { restoreSavedActiveId } from './sessionSwitch';
import { repaintActiveFromPage, sendFocus } from './sessionTransport';
import type { SessionActions } from './terminalSessionActions';
import type { TerminalSessionState } from './terminalSessionState';

function bindSessionPolling(
  opts: TerminalSessionsOptions,
  state: TerminalSessionState,
  readyRef: { current: boolean },
  onReachableRef: { current: TerminalSessionsOptions['onReachable'] },
) {
  return createHostPolling({
    getProfiles: () => opts.profiles,
    getActiveHostId: () => state.activeHostIdRef.current,
    getHealth: (profile) => state.healthRef.current.get(profile.id) ?? initialHostHealth(),
    clientFor: opts.clientFor,
    onSessions: (profile, sessions) =>
      applyPolledSessions({
        profile,
        sessions,
        activeHostId: state.activeHostIdRef.current,
        activeIdRef: state.activeIdRef,
        activeKeyRef: state.activeKeyRef,
        adoptedHosts: state.adoptedHostsRef.current,
        ready: readyRef.current,
        setDrawerSessions: state.setDrawerSessions,
        setActiveId: state.setActiveId,
        notifyWaiting: state.notifyWaitingSessionsRef.current,
        connectActive: () => state.connectRef.current(state.activeKeyRef.current),
      }),
    onHealth: (profile, result) => {
      state.updateHealthRef.current(profile, result);
      if (result === 'success') {
        void onReachableRef.current?.(profile);
        return;
      }
      probeUnreachableActiveHost({
        profile,
        activeHostId: state.activeHostIdRef.current,
        adoptedHosts: state.adoptedHostsRef.current,
        probedHosts: state.probedHostsRef.current,
        ready: readyRef.current,
        connectActive: () => state.connectRef.current(state.activeKeyRef.current),
      });
    },
  });
}

function onResumeActive(state: TerminalSessionState, actions: SessionActions, now: number) {
  sendFocus(actions.bag, true);
  for (const [key, connection] of Array.from(state.connections)) {
    switch (resumeAction(connection, now)) {
      case 'reconnect':
        connection.retry = 0;
        actions.connect(key);
        break;
      case 'close':
        try {
          connection.sock?.close();
        } catch {}
        break;
    }
  }
}

function useRestoreActiveId(opts: TerminalSessionsOptions, state: TerminalSessionState) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore only when the host profile id changes.
  useEffect(() => {
    restoreSavedActiveId({
      hostId: opts.client.profile.id,
      activeHostIdRef: state.activeHostIdRef,
      activeIdRef: state.activeIdRef,
      activeKeyRef: state.activeKeyRef,
      setActiveHostId: state.setActiveHostId,
      setActiveId: state.setActiveId,
    });
  }, [opts.client.profile.id]);
}

function useHydrateOnSwitch(state: TerminalSessionState, actions: SessionActions) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: session switches hydrate from the shadow.
  useEffect(() => {
    actions.hydrate();
  }, [state.activeId, state.activeHostId]);
}

function useThemeRepaint(
  opts: TerminalSessionsOptions,
  state: TerminalSessionState,
  actions: SessionActions,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme/font repaint from the live page buffer.
  useEffect(() => {
    if (!state.themePaintReadyRef.current) {
      state.themePaintReadyRef.current = true;
      return;
    }
    void repaintActiveFromPage(actions.bag);
  }, [opts.theme, opts.fontFamily, opts.fontSize]);
}

function useHostPollingEffect(opts: TerminalSessionsOptions, state: TerminalSessionState) {
  const readyRef = useRef(opts.ready);
  readyRef.current = opts.ready;
  const onReachableRef = useRef(opts.onReachable);
  onReachableRef.current = opts.onReachable;
  // biome-ignore lint/correctness/useExhaustiveDependencies: polling restarts when profiles/clientFor/configuring change.
  useEffect(() => {
    if (opts.isConfiguring || opts.profiles.length === 0) return;
    const polling = bindSessionPolling(opts, state, readyRef, onReachableRef);
    void polling.start().catch(() => {});
    return polling.stop;
  }, [opts.clientFor, opts.isConfiguring, opts.profiles]);
}

function useReadyTransportEffects(
  opts: TerminalSessionsOptions,
  state: TerminalSessionState,
  actions: SessionActions,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: connect reads the current client ref at call time.
  useEffect(() => {
    if (!opts.ready) return;
    return actions.disconnectAll;
  }, [opts.ready]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resume callbacks read active transport state at event time.
  useEffect(() => {
    if (!opts.ready) return;
    sendFocus(actions.bag, true);
    const subscription = AppState.addEventListener('change', (appState) => {
      state.appStateRef.current = appState;
      if (appState === 'background' || appState === 'inactive') {
        sendFocus(actions.bag, false);
        return;
      }
      if (appState !== 'active') return;
      onResumeActive(state, actions, Date.now());
    });
    return () => subscription.remove();
  }, [opts.ready]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount cleanup owns the transport created by this hook.
  useEffect(
    () => () => {
      actions.disconnectAll();
      state.outputBatcher.clear();
    },
    [],
  );
}

export function useTerminalSessionEffects(
  opts: TerminalSessionsOptions,
  state: TerminalSessionState,
  actions: SessionActions,
) {
  useRestoreActiveId(opts, state);
  useHydrateOnSwitch(state, actions);
  useThemeRepaint(opts, state, actions);
  useHostPollingEffect(opts, state);
  useReadyTransportEffects(opts, state, actions);
}
