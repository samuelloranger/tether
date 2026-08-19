import * as Haptics from 'expo-haptics';
import { writeClipboard } from '../clipboard';
import { nextTermId } from '../sessionCache';
import { initialHostHealth } from './hostHealth';
import type { PageControlEvent } from './pageControlState';
import {
  dropHostSessions,
  killActiveSession,
  refreshHostSessionList,
  type TerminalSessionsOptions,
} from './sessionHostOps';
import type { SessionRuntime } from './sessionRuntime';
import { nextIdsForHost, switchActiveSession } from './sessionSwitch';
import {
  applyRendererResize,
  cachedEntry,
  handlePageControl,
  hydrateRenderer,
  sendActiveJson,
} from './sessionTransport';
import { parseSessionKey, sessionKey } from './terminalSessionLogic';

// Host-scoped operations: everything that reads or refreshes the session list
// for a particular host profile.
function bindHostActions(opts: TerminalSessionsOptions, runtime: SessionRuntime) {
  const hydrate = (key = runtime.activeKeyRef.current) => hydrateRenderer(runtime.transport, key);
  const refreshSessionsFor = (profile: Parameters<typeof refreshHostSessionList>[0]['profile']) =>
    refreshHostSessionList({
      profile,
      client: opts.clientFor(profile),
      activeHostId: runtime.activeHostIdRef.current,
      setConnectionStatus: runtime.setConnectionStatus,
      setDrawerSessions: runtime.setDrawerSessions,
      notifyWaiting: runtime.notifyWaiting,
      updateHealth: runtime.updateHealth,
    });
  const refreshSessions = async () => {
    const profile =
      opts.profiles.find((candidate) => candidate.id === runtime.activeHostIdRef.current) ??
      runtime.clientRef.current.profile;
    await refreshSessionsFor(profile);
  };
  const switchTo = (hostId: string, id: string) => {
    void switchActiveSession({
      hostId,
      id,
      bag: runtime.transport,
      cache: runtime.cache,
      connections: runtime.connections,
      activeKeyRef: runtime.activeKeyRef,
      activeHostIdRef: runtime.activeHostIdRef,
      activeIdRef: runtime.activeIdRef,
      switchGenRef: runtime.switchGenRef,
      adoptedHosts: runtime.adoptedHostsRef.current,
      terminalViewRef: runtime.terminalViewRef,
      setActiveHostId: runtime.setActiveHostId,
      setActiveId: runtime.setActiveId,
      setConnectionStatus: runtime.setConnectionStatus,
      hydrate,
      connect: runtime.connect,
      onCloseDrawer: opts.onCloseDrawer,
      onClearView: opts.onClearView,
    });
  };
  return { hydrate, refreshSessionsFor, refreshSessions, switchTo };
}

// Operations the user triggers directly from the terminal chrome.
function bindTerminalActions(
  opts: TerminalSessionsOptions,
  runtime: SessionRuntime,
  host: ReturnType<typeof bindHostActions>,
) {
  const resetTerminal = () => {
    const entry = runtime.cache.get(runtime.activeKeyRef.current);
    if (!entry) return;
    entry.term.reset();
    entry.sinceId = 0;
    entry.lastAppliedId = 0;
    host.hydrate();
  };
  const newTerminal = () => {
    const hostId = runtime.activeHostIdRef.current;
    host.switchTo(
      hostId,
      nextTermId(nextIdsForHost(hostId, runtime.drawerSessions, runtime.cache, parseSessionKey)),
    );
  };
  const killActiveOr = (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    return killActiveSession({
      id,
      hostId: runtime.activeHostIdRef.current,
      getActiveKey: () => runtime.activeKeyRef.current,
      client: runtime.clientRef.current,
      cache: runtime.cache,
      drawerSessions: runtime.drawerSessions,
      disconnect: runtime.disconnect,
      refreshSessions: host.refreshSessions,
      onClearPresentation: opts.onClearPresentation,
      switchTo: host.switchTo,
    });
  };
  return { resetTerminal, newTerminal, killActiveOr };
}

// Renderer callbacks — the WebView/engine talking back into the session.
function bindRendererActions(runtime: SessionRuntime) {
  return {
    entryFor: (id: string) =>
      cachedEntry(runtime.transport, sessionKey(runtime.activeHostIdRef.current, id)),
    wsSend: (object: unknown) => sendActiveJson(runtime.transport, object),
    onRendererResize: (cols: number, rows: number) =>
      applyRendererResize(runtime.transport, cols, rows),
    onRendererSelection: (text: string) => {
      runtime.terminalSelectionRef.current = text;
    },
    onPageControl: (event: PageControlEvent) =>
      handlePageControl(runtime.transport, event, () =>
        runtime.setTerminalMetadataVersion((version) => version + 1),
      ),
    onPageClipboardWrite: (text: string) => {
      void writeClipboard(text).catch(() => {});
    },
  };
}

// Whole-host mutations driven by the hosts screen rather than the terminal.
function bindHostMutations(
  opts: TerminalSessionsOptions,
  runtime: SessionRuntime,
  host: ReturnType<typeof bindHostActions>,
  resetTerminal: () => void,
) {
  return {
    refreshHost: (hostId: string) => {
      const profile = opts.profiles.find((candidate) => candidate.id === hostId);
      if (profile) void host.refreshSessionsFor(profile);
    },
    resetHostHealth: (hostId: string) => {
      runtime.healthRef.current.set(hostId, initialHostHealth());
      runtime.setHealthByHost((previous) => ({ ...previous, [hostId]: 'unknown' }));
    },
    removeHost: (hostId: string) =>
      dropHostSessions({
        hostId,
        connections: runtime.connections,
        cache: runtime.cache,
        disconnect: runtime.disconnect,
        setDrawerSessions: runtime.setDrawerSessions,
        setHealthByHost: runtime.setHealthByHost,
      }),
    resetForEndpointChange: () => {
      runtime.setHasConnected(false);
      runtime.disconnectAll();
      resetTerminal();
      runtime.connectActive();
    },
  };
}

export function createSessionActions(opts: TerminalSessionsOptions, runtime: SessionRuntime) {
  const host = bindHostActions(opts, runtime);
  const terminal = bindTerminalActions(opts, runtime, host);
  const renderer = bindRendererActions(runtime);
  const mutations = bindHostMutations(opts, runtime, host, terminal.resetTerminal);
  return { ...host, ...terminal, ...renderer, ...mutations };
}

export type SessionActions = ReturnType<typeof createSessionActions>;
