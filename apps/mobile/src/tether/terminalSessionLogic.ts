import type { SessionActivity } from '../activity';
import type { DiffFileStat } from '../diffModel';
import type { DrawerSession } from '../SessionDrawer';
import { SessionCache, type SessionEntry } from '../sessionCache';
import type { ConnectionStatus, TerminalConnectionState } from './types';

type WsMessageContext = {
  id: string;
  drawerSessionId?: string;
  drawerHostId?: string;
  message: unknown;
  entry: SessionEntry | undefined;
  activeId: string;
  onGitSummaryChanged: () => void;
  onTerminalMetadataChanged: () => void;
  onDrawerSessions: (update: (rows: DrawerSession[]) => DrawerSession[]) => void;
  onWaitingSessions: (sessions: DrawerSession[]) => void;
  onOutput: (id: string, chunk: string) => void;
  onNotify: (id: string, entry: SessionEntry) => void;
  hydrateRenderer: (id: string) => void;
};

type NotificationContext = {
  id: string;
  entry: SessionEntry;
  activeId: string;
  windowFocused: boolean;
  notificationsEnabled: boolean;
  isDesktop: boolean;
  label?: string;
  notify: (title: string, body: string) => void;
};

type ReconnectContext = {
  id: string;
  readyRef: { current: boolean };
  delay: number;
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  reconnect: (id: string) => void;
};

export type SessionKeyParts = { hostId: string; sessionId: string };

/** A session id is unique only within its host, so cache and transport state use this key. */
export function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

export function parseSessionKey(key: string): SessionKeyParts {
  const separator = key.indexOf(':');
  if (separator < 1 || separator === key.length - 1) throw new Error(`Invalid session key: ${key}`);
  return { hostId: key.slice(0, separator), sessionId: key.slice(separator + 1) };
}

export function sessionSwitchAction(
  activeKey: string,
  targetKey: string,
  targetIsResident: boolean,
): 'none' | 'hydrate' | 'connect' {
  if (targetKey === activeKey) return 'none';
  return targetIsResident ? 'hydrate' : 'connect';
}

export function statusAfterClose(
  activeKey: string,
  closedKey: string,
  current: ConnectionStatus,
): ConnectionStatus {
  return activeKey === closedKey ? 'disconnected' : current;
}

export function focusFrame(focused: boolean): { type: 'focus'; focused: boolean } {
  return { type: 'focus', focused };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function backoffDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
  return base / 2 + Math.floor(random() * (base / 2));
}

export function runIfCurrentGeneration(
  state: Pick<TerminalConnectionState, 'gen'>,
  generation: number,
  callback: () => void,
): boolean {
  if (state.gen !== generation) return false;
  callback();
  return true;
}

export function scheduleReconnect({
  id,
  readyRef,
  delay,
  schedule,
  reconnect,
}: ReconnectContext): ReturnType<typeof setTimeout> | null {
  if (!readyRef.current) return null;
  return schedule(() => {
    if (readyRef.current) reconnect(id);
  }, delay);
}

export function createSessionCache(disconnect: (id: string) => void): SessionCache {
  return new SessionCache(3, (id) => disconnect(id));
}

/** Applies one parsed wire message using explicit side effects, without React state closures. */
export function applyWsMessage({
  id,
  drawerSessionId = id,
  drawerHostId = '',
  message,
  entry,
  activeId,
  onGitSummaryChanged,
  onTerminalMetadataChanged,
  onDrawerSessions,
  onWaitingSessions,
  onOutput,
  onNotify,
  hydrateRenderer,
}: WsMessageContext): void {
  const payload = object(message);
  if (!payload || !entry || typeof payload.type !== 'string') return;
  if (payload.type === 'diff') {
    const summary = object(payload.summary);
    if (!Array.isArray(summary?.files)) return;
    entry.diffSummary = { files: summary.files as DiffFileStat[] };
    if (id === activeId) onGitSummaryChanged();
    return;
  }
  if (payload.type === 'output') {
    if (typeof payload.id !== 'number' || payload.id <= entry.lastAppliedId) return;
    const chunk = payload.chunk;
    if (typeof chunk !== 'string') return;
    entry.lastAppliedId = payload.id;
    entry.sinceId = payload.id;
    const previous = [
      entry.term.bellCount,
      entry.term.promptReturnCount,
      entry.term.title,
      entry.term.cwd,
    ] as const;
    entry.term.write(chunk, () => {
      onNotify(id, entry);
      if (
        id === activeId &&
        (entry.term.bellCount !== previous[0] ||
          entry.term.promptReturnCount !== previous[1] ||
          entry.term.title !== previous[2] ||
          entry.term.cwd !== previous[3])
      )
        onTerminalMetadataChanged();
      onOutput(id, chunk);
    });
    return;
  }
  if (payload.type === 'exit') {
    const code = typeof payload.exitCode === 'number' ? ` with code ${payload.exitCode}` : '';
    const text = `\r\n\x1b[31m[Process exited${code}]\x1b[0m\r\n`;
    entry.term.write(text, () => onOutput(id, text));
    return;
  }
  if (payload.type === 'title' && typeof payload.title === 'string') {
    const title = payload.title;
    onDrawerSessions((rows) =>
      rows.map((row) => (row.id === drawerSessionId ? { ...row, auto_title: title } : row)),
    );
    return;
  }
  if (payload.type === 'activity') {
    const activity = payload.activity as SessionActivity;
    onDrawerSessions((rows) =>
      rows.map((row) => (row.id === drawerSessionId ? { ...row, activity } : row)),
    );
    onWaitingSessions([
      {
        id: drawerSessionId,
        hostId: drawerHostId,
        status: 'running',
        last_output_at: null,
        activity,
      },
    ]);
    return;
  }
  if (payload.type === 'reset') {
    entry.term.reset();
    entry.sinceId = 0;
    entry.lastAppliedId = 0;
    entry.lastBellCount = 0;
    entry.lastNotifyCount = 0;
    if (id === activeId) hydrateRenderer(id);
  }
}

/** Consumes new bell/OSC notification edges before deciding whether to display them. */
export function maybeNotify({
  id,
  entry,
  activeId,
  windowFocused,
  notificationsEnabled,
  isDesktop,
  label = id,
  notify,
}: NotificationContext): void {
  const notifyFired = entry.term.notifyCount > entry.lastNotifyCount;
  const bellFired = entry.term.bellCount > entry.lastBellCount;
  entry.lastNotifyCount = entry.term.notifyCount;
  entry.lastBellCount = entry.term.bellCount;
  if (!isDesktop || !notificationsEnabled || (id === activeId && windowFocused)) return;
  if (notifyFired) {
    const { title, body } = entry.term.lastNotify;
    notify(title || label, body || 'Needs your input');
  } else if (bellFired) notify(label, 'Terminal bell');
}
