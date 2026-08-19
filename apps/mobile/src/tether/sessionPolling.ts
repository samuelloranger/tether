import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DrawerSession } from '../SessionDrawer';
import type { HostProfile } from './hostStore';
import { activeSessionStorageKey } from './sessionSwitch';
import { sessionKey } from './terminalSessionLogic';

export function applyPolledSessions(args: {
  profile: HostProfile;
  sessions: unknown;
  activeHostId: string;
  activeIdRef: { current: string };
  activeKeyRef: { current: string };
  adoptedHosts: Set<string>;
  ready: boolean;
  setDrawerSessions: (update: (previous: DrawerSession[]) => DrawerSession[]) => void;
  setActiveId: (id: string) => void;
  notifyWaiting: (rows: DrawerSession[]) => void;
  connectActive: () => void;
}): void {
  const rows = (args.sessions as Omit<DrawerSession, 'hostId'>[]).map((row) => ({
    ...row,
    hostId: args.profile.id,
  }));
  args.setDrawerSessions((previous) => [
    ...previous.filter((row) => row.hostId !== args.profile.id),
    ...rows,
  ]);
  if (args.profile.id !== args.activeHostId) return;
  args.notifyWaiting(rows);
  if (args.adoptedHosts.has(args.profile.id)) return;
  args.adoptedHosts.add(args.profile.id);
  // Adopt the most recent live session rather than creating another one.
  // Only a host with no sessions at all gets a fresh `term-1`.
  const running = rows.filter((row) => row.status === 'running');
  if (running.length && !running.some((row) => row.id === args.activeIdRef.current)) {
    const newest = [...running].sort((a, b) =>
      (b.last_output_at ?? '').localeCompare(a.last_output_at ?? ''),
    )[0];
    args.activeIdRef.current = newest.id;
    args.activeKeyRef.current = sessionKey(args.profile.id, newest.id);
    args.setActiveId(newest.id);
    void AsyncStorage.setItem(activeSessionStorageKey(args.profile.id), newest.id);
  }
  if (args.ready) args.connectActive();
}

export function probeUnreachableActiveHost(args: {
  profile: HostProfile;
  activeHostId: string;
  adoptedHosts: Set<string>;
  probedHosts: Set<string>;
  ready: boolean;
  connectActive: () => void;
}): boolean {
  if (args.profile.id !== args.activeHostId) return false;
  if (args.adoptedHosts.has(args.profile.id) || args.probedHosts.has(args.profile.id)) return false;
  if (!args.ready) return false;
  // The host answered with a failure, so there is no session list coming.
  // Open the socket to surface the real connection state — but do NOT mark
  // the host adopted: if it later recovers, its list must still be able to
  // adopt an existing session instead of leaving us on the default id.
  args.probedHosts.add(args.profile.id);
  args.connectActive();
  return true;
}
