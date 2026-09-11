/**
 * What a session can notify about. Kept separate from delivery so the trigger
 * vocabulary is shared by the PTY (which raises events) and `push.ts` (which
 * words and delivers them).
 */
export type NotificationEvent =
  | { type: 'waiting' }
  | { type: 'done'; title?: string; body?: string }
  | { type: 'oscNotify'; title?: string; body?: string }
  | { type: 'exit'; exitCode?: number }
  | { type: 'longJob'; seconds: number };

export interface NotificationContext {
  sessionId: string;
  sessionTitle: string;
}

/** The slice of an output-path activity event that can raise a push. */
export interface OutputPushSource {
  activity: string | null;
  notify: { title?: string; body?: string } | null;
  longJob: boolean;
}

/**
 * Pushes raised from one PTY output flush.
 *
 * Attention (OSC or waiting) wins: a chunk that already means "needs you" must
 * not also fire the long-job completion ping.
 */
export function pushesFromOutput(
  event: OutputPushSource,
  longJobSeconds: number,
): NotificationEvent[] {
  if (event.notify) return [{ type: 'oscNotify', ...event.notify }];
  if (event.activity === 'waiting') return [{ type: 'waiting' }];
  if (event.longJob) return [{ type: 'longJob', seconds: longJobSeconds }];
  return [];
}

/**
 * An explicit Kill is a user action, not a surprise death — never push for it.
 * A natural shell/PTY exit still raises the event; the trigger toggle decides
 * whether it is delivered.
 */
export function pushFromExit(wasKilled: boolean, exitCode?: number): NotificationEvent | null {
  if (wasKilled) return null;
  return { type: 'exit', exitCode };
}
