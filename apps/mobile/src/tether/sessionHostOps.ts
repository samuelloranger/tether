import type { DrawerSession } from '../SessionDrawer';
import type { SessionCache } from '../sessionCache';
import type { HostClient } from './hostClient';
import {
  type HostHealth,
  hostHealthAfterFailure,
  hostHealthAfterResponse,
  initialHostHealth,
} from './hostHealth';
import type { PollResult } from './hostPolling';
import type { HostProfile } from './hostStore';
import { parseSessionKey, sessionKey } from './terminalSessionLogic';
import type { ConnectionStatus, TerminalConnectionState } from './types';

export type TerminalSessionsOptions = {
  client: HostClient;
  profiles: HostProfile[];
  clientFor: (profile: HostProfile) => HostClient;
  onReachable?: (profile: HostProfile) => void;
  ready: boolean;
  isConfiguring: boolean;
  theme: { terminal: { fg: string; bg: string }; keyboardAppearance: 'light' | 'dark' };
  fontFamily: string;
  fontSize: number;
  notificationsEnabledRef: { current: boolean };
  onClearView: () => void;
  onClearPresentation: () => void;
  onCloseDrawer: () => void;
};

export function applyHostHealth(
  health: Map<string, HostHealth>,
  profile: HostProfile,
  result: PollResult,
  setHealthByHost: (
    update: (
      previous: Record<string, HostHealth['status']>,
    ) => Record<string, HostHealth['status']>,
  ) => void,
): HostHealth {
  const current = health.get(profile.id) ?? initialHostHealth();
  const next =
    result === 'success'
      ? hostHealthAfterResponse(current, 200)
      : result === 'unauthorized'
        ? hostHealthAfterResponse(current, 401)
        : hostHealthAfterFailure(current);
  health.set(profile.id, next);
  setHealthByHost((previous) => ({ ...previous, [profile.id]: next.status }));
  return next;
}

export async function refreshHostSessionList(args: {
  profile: HostProfile;
  client: HostClient;
  activeHostId: string;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setDrawerSessions: (update: (previous: DrawerSession[]) => DrawerSession[]) => void;
  notifyWaiting: (rows: DrawerSession[]) => void;
  updateHealth: (profile: HostProfile, result: PollResult) => void;
}): Promise<void> {
  try {
    const response = await args.client.get('/api/sessions');
    if (response.status === 401) {
      args.updateHealth(args.profile, 'unauthorized');
      if (args.profile.id === args.activeHostId) args.setConnectionStatus('auth-failed');
      return;
    }
    if (!response.ok) throw new Error(`Session polling failed (${response.status})`);
    const sessions = await response.json();
    if (!Array.isArray(sessions)) throw new Error('Session response was not an array');
    const rows = sessions.map((row) => ({
      ...(row as Omit<DrawerSession, 'hostId'>),
      hostId: args.profile.id,
    })) as DrawerSession[];
    args.setDrawerSessions((previous) => [
      ...previous.filter((row) => row.hostId !== args.profile.id),
      ...rows,
    ]);
    if (args.profile.id === args.activeHostId) args.notifyWaiting(rows);
    args.updateHealth(args.profile, 'success');
  } catch {
    args.updateHealth(args.profile, 'failure');
  }
}

export async function killActiveSession(args: {
  id: string;
  hostId: string;
  // Read at call time, not snapshotted: the active tab can change while the
  // kill + refresh round-trips are in flight.
  getActiveKey: () => string;
  client: HostClient;
  cache: SessionCache;
  drawerSessions: DrawerSession[];
  disconnect: (key: string) => void;
  refreshSessions: () => Promise<void>;
  onClearPresentation: () => void;
  switchTo: (hostId: string, id: string) => void;
}): Promise<void> {
  const key = sessionKey(args.hostId, args.id);
  try {
    await args.client.post('/api/sessions/kill', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: args.id }),
    });
  } catch {}
  args.cache.delete(key);
  args.disconnect(key);
  const remaining = args.drawerSessions.filter((row) => row.id !== args.id).map((row) => row.id);
  await args.refreshSessions();
  if (key === args.getActiveKey()) {
    args.onClearPresentation();
    args.switchTo(args.hostId, remaining[0] ?? 'term-1');
  }
}

export function dropHostSessions(args: {
  hostId: string;
  connections: Map<string, TerminalConnectionState>;
  cache: SessionCache;
  disconnect: (key: string) => void;
  setDrawerSessions: (update: (previous: DrawerSession[]) => DrawerSession[]) => void;
  setHealthByHost: (
    update: (
      previous: Record<string, HostHealth['status']>,
    ) => Record<string, HostHealth['status']>,
  ) => void;
}): void {
  for (const key of Array.from(args.connections.keys())) {
    if (parseSessionKey(key).hostId === args.hostId) args.disconnect(key);
  }
  for (const key of args.cache.ids()) {
    if (parseSessionKey(key).hostId === args.hostId) args.cache.delete(key);
  }
  args.setDrawerSessions((previous) => previous.filter((row) => row.hostId !== args.hostId));
  args.setHealthByHost((previous) => {
    const { [args.hostId]: _removed, ...rest } = previous;
    return rest;
  });
}
