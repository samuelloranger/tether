import type { HostClientResponse } from './hostClient';
import type { HostProfile } from './hostStore';

const ACTIVE_POLL_INTERVAL_MS = 4_000;
const BACKGROUND_POLL_INTERVAL_MS = 15_000;

export type PollResult = 'success' | 'failure' | 'unauthorized';

type SessionsClient = { get(path: string): Promise<HostClientResponse> };

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
}): Promise<void> {
  await Promise.all(
    profiles.map(async (profile) => {
      try {
        const response = await clientFor(profile).get('/api/sessions');
        if (response.status === 401) {
          await onHealth(profile, 'unauthorized');
          return;
        }
        if (!response.ok) throw new Error(`Session polling failed (${response.status})`);
        const sessions = await response.json();
        if (!Array.isArray(sessions)) throw new Error('Session response was not an array');
        await onSessions(profile, sessions);
        await onHealth(profile, 'success');
      } catch {
        // This boundary intentionally contains each profile independently.
        // One offline host must never reject the shared polling cycle.
        try {
          await onHealth(profile, 'failure');
        } catch {
          // State observers are isolated too, so their failure cannot escape.
        }
      }
    }),
  );
  void activeHostId;
}

export function createHostPolling({
  getProfiles,
  getActiveHostId,
  clientFor,
  onSessions,
  onHealth,
  schedule = (run, delay) => setTimeout(run, delay),
  clearScheduled = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: {
  getProfiles(): HostProfile[];
  getActiveHostId(): string | null;
  clientFor(profile: HostProfile): SessionsClient;
  onSessions(profile: HostProfile, sessions: unknown[]): void | Promise<void>;
  onHealth(profile: HostProfile, result: PollResult): void | Promise<void>;
  schedule(run: () => void, delay: number): unknown;
  clearScheduled(handle: unknown): void;
}) {
  let stopped = false;
  const timers = new Map<string, unknown>();

  const pollAndSchedule = async (profile: HostProfile): Promise<void> => {
    await pollHostSessions({
      profiles: [profile],
      activeHostId: getActiveHostId(),
      clientFor,
      onSessions,
      onHealth,
    });
    if (stopped) return;
    try {
      const delay = sessionPollInterval(profile.id === getActiveHostId());
      timers.set(
        profile.id,
        schedule(() => {
          void pollAndSchedule(profile).catch(() => {});
        }, delay),
      );
    } catch {
      // Scheduling must not turn a dead host into an unhandled rejection.
    }
  };

  return {
    async start(): Promise<void> {
      stopped = false;
      await Promise.all(getProfiles().map((profile) => pollAndSchedule(profile)));
    },
    stop(): void {
      stopped = true;
      for (const timer of timers.values()) clearScheduled(timer);
      timers.clear();
    },
  };
}
