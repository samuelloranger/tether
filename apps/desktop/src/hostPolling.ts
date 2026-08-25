import {
  type HostHealth,
  hostHealthAfterFailure,
  hostHealthAfterResponse,
  nextHostPollDelay,
} from './hostHealth';
import type { HostProfile } from './hostStore';

const ACTIVE_POLL_INTERVAL_MS = 4_000;
const BACKGROUND_POLL_INTERVAL_MS = 15_000;

export type PollResult = 'success' | 'failure' | 'unauthorized';

type SessionsClient = { get(path: string): Promise<Response> };

export function sessionPollInterval(isActiveHost: boolean): number {
  return isActiveHost ? ACTIVE_POLL_INTERVAL_MS : BACKGROUND_POLL_INTERVAL_MS;
}

export async function pollHostSessions({
  profiles,
  activeHostId,
  clientFor,
  onSessions,
  onHealth,
}: {
  profiles: HostProfile[];
  activeHostId: string | null;
  clientFor(profile: HostProfile): SessionsClient;
  onSessions(profile: HostProfile, sessions: unknown[]): void | Promise<void>;
  onHealth(profile: HostProfile, result: PollResult): void | Promise<void>;
}): Promise<Map<string, PollResult>> {
  const results = new Map<string, PollResult>();
  await Promise.all(
    profiles.map(async (profile) => {
      try {
        const response = await clientFor(profile).get('/api/sessions');
        if (response.status === 401) {
          results.set(profile.id, 'unauthorized');
          await onHealth(profile, 'unauthorized');
          return;
        }
        if (!response.ok) throw new Error(`Session polling failed (${response.status})`);
        const sessions = await response.json();
        if (!Array.isArray(sessions)) throw new Error('Session response was not an array');
        await onSessions(profile, sessions);
        results.set(profile.id, 'success');
        await onHealth(profile, 'success');
      } catch {
        results.set(profile.id, 'failure');
        try {
          await onHealth(profile, 'failure');
        } catch {
          // isolated
        }
      }
    }),
  );
  void activeHostId;
  return results;
}

export function createHostPolling({
  getProfiles,
  getActiveHostId,
  getHealth,
  clientFor,
  onSessions,
  onHealth,
  schedule = (run, delay) => setTimeout(run, delay),
  clearScheduled = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: {
  getProfiles(): HostProfile[];
  getActiveHostId(): string | null;
  getHealth(profile: HostProfile): HostHealth;
  clientFor(profile: HostProfile): SessionsClient;
  onSessions(profile: HostProfile, sessions: unknown[]): void | Promise<void>;
  onHealth(profile: HostProfile, result: PollResult): void | Promise<void>;
  schedule?: (run: () => void, delay: number) => unknown;
  clearScheduled?: (handle: unknown) => void;
}) {
  let stopped = false;
  const timers = new Map<string, unknown>();

  const pollAndSchedule = async (profile: HostProfile): Promise<void> => {
    const results = await pollHostSessions({
      profiles: [profile],
      activeHostId: getActiveHostId(),
      clientFor,
      onSessions,
      onHealth,
    });
    if (stopped) return;
    try {
      const result = results.get(profile.id);
      const previous = getHealth(profile);
      const health =
        result === 'success'
          ? hostHealthAfterResponse(previous, 200)
          : result === 'unauthorized'
            ? hostHealthAfterResponse(previous, 401)
            : hostHealthAfterFailure(previous);
      const delay = nextHostPollDelay(
        health,
        sessionPollInterval(profile.id === getActiveHostId()),
      );
      if (delay === null) return;
      timers.set(
        profile.id,
        schedule(() => {
          void pollAndSchedule(profile).catch(() => {});
        }, delay),
      );
    } catch {
      // scheduling must not escape
    }
  };

  return {
    async start(): Promise<void> {
      stopped = false;
      await Promise.all(getProfiles().map((profile) => pollAndSchedule(profile)));
    },
    restart(): void {
      for (const timer of timers.values()) clearScheduled(timer);
      timers.clear();
      if (!stopped) void this.start();
    },
    stop(): void {
      stopped = true;
      for (const timer of timers.values()) clearScheduled(timer);
      timers.clear();
    },
  };
}

export function applyPollHealth(health: HostHealth, result: PollResult): HostHealth {
  if (result === 'success') return hostHealthAfterResponse(health, 200);
  if (result === 'unauthorized') return hostHealthAfterResponse(health, 401);
  return hostHealthAfterFailure(health);
}
