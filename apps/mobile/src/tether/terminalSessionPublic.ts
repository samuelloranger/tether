import { resolveClientForKey } from './sessionTransport';
import type { SessionActions, sessionHostMutations } from './terminalSessionActions';
import { sessionKey } from './terminalSessionLogic';
import type { TerminalSessionState } from './terminalSessionState';

type HostMutations = ReturnType<typeof sessionHostMutations>;

export function sessionPublicApi(
  state: TerminalSessionState,
  actions: SessionActions,
  mutations: HostMutations,
) {
  return {
    activeId: state.activeId,
    activeHostId: state.activeHostId,
    activeClient: resolveClientForKey(actions.bag, state.activeKeyRef.current),
    connectionStatus: state.connectionStatus,
    hasConnected: state.hasConnected,
    drawerSessions: state.drawerSessions,
    healthByHost: state.healthByHost,
    terminalViewRef: state.terminalViewRef,
    entryFor: actions.entryFor,
    getSessionEntry: (id: string) => state.cache.get(sessionKey(state.activeHostIdRef.current, id)),
    getActiveSessionId: () => state.activeIdRef.current,
    getTerminalSelection: () => state.terminalSelectionRef.current,
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
    ...mutations,
    restartActiveSession: () => actions.connect(state.activeKeyRef.current),
    markAuthFailed: () => state.setConnectionStatus('auth-failed'),
    refreshSocketActivity: () => {
      const now = Date.now();
      for (const connection of state.connections.values())
        if (connection.open) connection.lastSeen = now;
    },
    setWindowFocused: (focused: boolean) => {
      state.windowFocusedRef.current = focused;
    },
    isWindowFocused: () => state.windowFocusedRef.current,
  };
}
