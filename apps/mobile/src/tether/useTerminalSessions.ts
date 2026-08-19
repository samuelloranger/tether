import type { TerminalSessionsOptions } from './sessionHostOps';
import { useSessionRuntime } from './sessionRuntime';
import { resolveClientForKey } from './sessionTransport';
import { createSessionActions } from './terminalSessionActions';
import { useTerminalSessionEffects } from './terminalSessionEffects';
import { sessionKey } from './terminalSessionLogic';

export function useTerminalSessions(opts: TerminalSessionsOptions) {
  const runtime = useSessionRuntime(opts);
  const actions = createSessionActions(opts, runtime);
  useTerminalSessionEffects(opts, runtime, actions);

  // The public surface is deliberately flat and read-only from the caller's
  // side: App.tsx destructures it by name, so the runtime's mutable internals
  // (refs, the transport bag, the cache) never leak past this boundary.
  return {
    activeId: runtime.activeId,
    activeHostId: runtime.activeHostId,
    activeClient: resolveClientForKey(runtime.transport, runtime.activeKeyRef.current),
    connectionStatus: runtime.connectionStatus,
    hasConnected: runtime.hasConnected,
    drawerSessions: runtime.drawerSessions,
    healthByHost: runtime.healthByHost,
    terminalViewRef: runtime.terminalViewRef,

    entryFor: actions.entryFor,
    getSessionEntry: (id: string) =>
      runtime.cache.get(sessionKey(runtime.activeHostIdRef.current, id)),
    getActiveSessionId: () => runtime.activeIdRef.current,
    getTerminalSelection: () => runtime.terminalSelectionRef.current,

    wsSend: actions.wsSend,
    hydrateRenderer: actions.hydrate,
    onRendererResize: actions.onRendererResize,
    onRendererSelection: actions.onRendererSelection,
    onPageControl: actions.onPageControl,
    onPageReply: (data: string) => actions.wsSend({ type: 'input', text: data }),
    onPageClipboardWrite: actions.onPageClipboardWrite,

    resetTerminal: actions.resetTerminal,
    switchTo: actions.switchTo,
    newTerminal: actions.newTerminal,
    killActiveOr: actions.killActiveOr,
    refreshSessions: actions.refreshSessions,
    refreshHost: actions.refreshHost,
    resetHostHealth: actions.resetHostHealth,
    removeHost: actions.removeHost,
    resetForEndpointChange: actions.resetForEndpointChange,

    restartActiveSession: runtime.connectActive,
    markAuthFailed: () => runtime.setConnectionStatus('auth-failed'),
    refreshSocketActivity: () => {
      const now = Date.now();
      for (const connection of runtime.connections.values())
        if (connection.open) connection.lastSeen = now;
    },
    setWindowFocused: (focused: boolean) => {
      runtime.windowFocusedRef.current = focused;
    },
    isWindowFocused: () => runtime.windowFocusedRef.current,
  };
}
