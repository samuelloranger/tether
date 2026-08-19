import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { resumeAction } from '../resume';
import { initialHostHealth } from './hostHealth';
import { createHostPolling } from './hostPolling';
import type { TerminalSessionsOptions } from './sessionHostOps';
import { applyPolledSessions, probeUnreachableActiveHost } from './sessionPolling';
import type { SessionRuntime } from './sessionRuntime';
import { restoreSavedActiveId } from './sessionSwitch';
import { repaintActiveFromPage, sendFocus } from './sessionTransport';
import type { SessionActions } from './terminalSessionActions';

function bindSessionPolling(
  opts: TerminalSessionsOptions,
  runtime: SessionRuntime,
  onReachableRef: { current: TerminalSessionsOptions['onReachable'] },
) {
  return createHostPolling({
    getProfiles: () => opts.profiles,
    getActiveHostId: () => runtime.activeHostIdRef.current,
    getHealth: (profile) => runtime.healthRef.current.get(profile.id) ?? initialHostHealth(),
    clientFor: opts.clientFor,
    onSessions: (profile, sessions) =>
      applyPolledSessions({
        profile,
        sessions,
        activeHostId: runtime.activeHostIdRef.current,
        activeIdRef: runtime.activeIdRef,
        activeKeyRef: runtime.activeKeyRef,
        adoptedHosts: runtime.adoptedHostsRef.current,
        // Read at poll time, not captured at effect setup: the polling loop
        // outlives many renders and must see the current ready flag.
        ready: runtime.readyRef.current,
        setDrawerSessions: runtime.setDrawerSessions,
        setActiveId: runtime.setActiveId,
        notifyWaiting: runtime.notifyWaiting,
        connectActive: runtime.connectActive,
      }),
    onHealth: (profile, result) => {
      runtime.updateHealth(profile, result);
      if (result === 'success') {
        void onReachableRef.current?.(profile);
        return;
      }
      probeUnreachableActiveHost({
        profile,
        activeHostId: runtime.activeHostIdRef.current,
        adoptedHosts: runtime.adoptedHostsRef.current,
        probedHosts: runtime.probedHostsRef.current,
        // Read at poll time, not captured at effect setup: the polling loop
        // outlives many renders and must see the current ready flag.
        ready: runtime.readyRef.current,
        connectActive: runtime.connectActive,
      });
    },
  });
}

function onResumeActive(runtime: SessionRuntime, now: number) {
  sendFocus(runtime.transport, true);
  for (const [key, connection] of Array.from(runtime.connections)) {
    switch (resumeAction(connection, now)) {
      case 'reconnect':
        connection.retry = 0;
        runtime.connect(key);
        break;
      case 'close':
        try {
          connection.sock?.close();
        } catch {}
        break;
    }
  }
}

function useRestoreActiveId(opts: TerminalSessionsOptions, runtime: SessionRuntime) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore only when the host profile id changes.
  useEffect(() => {
    restoreSavedActiveId({
      hostId: opts.client.profile.id,
      activeHostIdRef: runtime.activeHostIdRef,
      activeIdRef: runtime.activeIdRef,
      activeKeyRef: runtime.activeKeyRef,
      setActiveHostId: runtime.setActiveHostId,
      setActiveId: runtime.setActiveId,
    });
  }, [opts.client.profile.id]);
}

function useHydrateOnSwitch(runtime: SessionRuntime, actions: SessionActions) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: session switches hydrate from the shadow.
  useEffect(() => {
    actions.hydrate();
  }, [runtime.activeId, runtime.activeHostId]);
}

function useThemeRepaint(opts: TerminalSessionsOptions, runtime: SessionRuntime) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme/font repaint from the live page buffer.
  useEffect(() => {
    if (!runtime.themePaintReadyRef.current) {
      runtime.themePaintReadyRef.current = true;
      return;
    }
    void repaintActiveFromPage(runtime.transport);
  }, [opts.theme, opts.fontFamily, opts.fontSize]);
}

function useHostPollingEffect(opts: TerminalSessionsOptions, runtime: SessionRuntime) {
  // Only the callback is allowed to go stale-free across renders; the polling
  // loop itself must survive unrelated re-renders, so it is not a dependency.
  const onReachableRef = useRef(opts.onReachable);
  onReachableRef.current = opts.onReachable;
  // biome-ignore lint/correctness/useExhaustiveDependencies: polling restarts when profiles/clientFor/configuring change.
  useEffect(() => {
    if (opts.isConfiguring || opts.profiles.length === 0) return;
    const polling = bindSessionPolling(opts, runtime, onReachableRef);
    void polling.start().catch(() => {});
    return polling.stop;
  }, [opts.clientFor, opts.isConfiguring, opts.profiles]);
}

function useReadyTransportEffects(opts: TerminalSessionsOptions, runtime: SessionRuntime) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: connect reads the current client ref at call time.
  useEffect(() => {
    if (!opts.ready) return;
    return runtime.disconnectAll;
  }, [opts.ready]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resume callbacks read active transport state at event time.
  useEffect(() => {
    if (!opts.ready) return;
    sendFocus(runtime.transport, true);
    const subscription = AppState.addEventListener('change', (appState) => {
      runtime.appStateRef.current = appState;
      if (appState === 'background' || appState === 'inactive') {
        sendFocus(runtime.transport, false);
        return;
      }
      if (appState !== 'active') return;
      onResumeActive(runtime, Date.now());
    });
    return () => subscription.remove();
  }, [opts.ready]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount cleanup owns the transport created by this hook.
  useEffect(
    () => () => {
      runtime.disconnectAll();
      runtime.outputBatcher.clear();
    },
    [],
  );
}

export function useTerminalSessionEffects(
  opts: TerminalSessionsOptions,
  runtime: SessionRuntime,
  actions: SessionActions,
) {
  useRestoreActiveId(opts, runtime);
  useHydrateOnSwitch(runtime, actions);
  useThemeRepaint(opts, runtime);
  useHostPollingEffect(opts, runtime);
  useReadyTransportEffects(opts, runtime);
}
