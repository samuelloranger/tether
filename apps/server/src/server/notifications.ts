/**
 * What a session can notify about. Kept separate from delivery so the trigger
 * vocabulary is shared by the PTY (which raises events) and `push.ts` (which
 * words and delivers them).
 */
export type NotificationEvent =
  | { type: 'waiting' }
  | { type: 'oscNotify'; title?: string; body?: string }
  | { type: 'exit'; exitCode?: number }
  | { type: 'longJob'; seconds: number };

export interface NotificationContext {
  sessionId: string;
  sessionTitle: string;
}
