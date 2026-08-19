import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DrawerSession } from '../SessionDrawer';
import type { SessionCache } from '../sessionCache';
import type { TerminalViewHandle } from '../TerminalView.types';
import { completeShadowHandoff } from './pageControlState';
import {
  cachedEntry,
  type SessionHandoff,
  type SessionTransportBag,
  sendFocus,
} from './sessionTransport';
import { sessionKey, sessionSwitchAction } from './terminalSessionLogic';
import type { ConnectionStatus, TerminalConnectionState } from './types';

const activeSessionStorageKey = (hostId: string) => `tether_session_id_${hostId}`;
const KEY_ACTIVE_HOST = 'tether_active_host';

export { activeSessionStorageKey, KEY_ACTIVE_HOST };

export function restoreSavedActiveId(args: {
  hostId: string;
  activeHostIdRef: { current: string };
  activeIdRef: { current: string };
  activeKeyRef: { current: string };
  setActiveHostId: (id: string) => void;
  setActiveId: (id: string) => void;
}): void {
  if (args.hostId === 'pending') return;
  if (args.activeHostIdRef.current === 'pending') {
    args.activeHostIdRef.current = args.hostId;
    args.activeKeyRef.current = sessionKey(args.hostId, args.activeIdRef.current);
    args.setActiveHostId(args.hostId);
  }
  void AsyncStorage.getItem(activeSessionStorageKey(args.hostId)).then((savedId) => {
    if (!savedId) return;
    args.activeHostIdRef.current = args.hostId;
    args.activeIdRef.current = savedId;
    args.activeKeyRef.current = sessionKey(args.hostId, savedId);
    args.setActiveHostId(args.hostId);
    args.setActiveId(savedId);
  });
}

export async function switchActiveSession(args: {
  hostId: string;
  id: string;
  bag: SessionTransportBag;
  cache: SessionCache;
  connections: Map<string, TerminalConnectionState>;
  activeKeyRef: { current: string };
  activeHostIdRef: { current: string };
  activeIdRef: { current: string };
  switchGenRef: { current: number };
  adoptedHosts: Set<string>;
  terminalViewRef: { current: TerminalViewHandle | null };
  setActiveHostId: (hostId: string) => void;
  setActiveId: (id: string) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  hydrate: (key: string) => void;
  connect: (key: string) => void;
  onCloseDrawer: () => void;
  onClearView: () => void;
}): Promise<void> {
  const targetKey = sessionKey(args.hostId, args.id);
  const previousKey = args.activeKeyRef.current;
  const action = sessionSwitchAction(previousKey, targetKey, args.cache.has(targetKey));
  args.onCloseDrawer();
  args.onClearView();
  if (action === 'none') return;
  const gen = ++args.switchGenRef.current;
  if (previousKey !== targetKey && args.cache.has(previousKey)) {
    const handoff: SessionHandoff = { key: previousKey, chunks: [] };
    args.bag.handoffRef.current = handoff;
    try {
      const previous = args.cache.get(previousKey);
      if (previous) {
        await completeShadowHandoff({
          term: previous.term,
          handoff,
          serialize: () => {
            const view = args.terminalViewRef.current;
            if (!view) return Promise.reject(new Error('terminal view unavailable'));
            return view.serialize();
          },
          isAvailable: () => args.terminalViewRef.current != null,
          entry: previous,
        });
      }
    } catch (error) {
      console.warn('shadow handoff: unexpected failure', error);
    } finally {
      if (args.bag.handoffRef.current === handoff) args.bag.handoffRef.current = null;
    }
  }
  if (gen !== args.switchGenRef.current) return;
  sendFocus(args.bag, false);
  // The user picked this session explicitly, so the host is adopted. Without
  // this, the host's next poll would run the adoption branch and reconnect —
  // disconnecting the socket that was just opened.
  args.adoptedHosts.add(args.hostId);
  args.activeHostIdRef.current = args.hostId;
  args.activeIdRef.current = args.id;
  args.activeKeyRef.current = targetKey;
  args.setActiveHostId(args.hostId);
  args.setActiveId(args.id);
  void AsyncStorage.multiSet([
    [KEY_ACTIVE_HOST, args.hostId],
    [activeSessionStorageKey(args.hostId), args.id],
  ]);
  cachedEntry(args.bag, targetKey);
  args.hydrate(targetKey);
  if (action === 'hydrate') {
    args.setConnectionStatus(args.connections.get(targetKey)?.open ? 'connected' : 'disconnected');
    sendFocus(args.bag, true);
  } else args.connect(targetKey);
}

export function nextIdsForHost(
  hostId: string,
  drawerSessions: DrawerSession[],
  cache: SessionCache,
  parse: (key: string) => { hostId: string; sessionId: string },
): string[] {
  if (drawerSessions.length) return drawerSessions.map((row) => row.id);
  return cache
    .ids()
    .map(parse)
    .filter((key) => key.hostId === hostId)
    .map((key) => key.sessionId);
}
