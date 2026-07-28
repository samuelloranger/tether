import type { SessionActivity } from '../activity';
import { wsUrl } from '../address';
import type { DiffFileStat } from '../diffModel';
import type { DrawerSession } from '../SessionDrawer';
import { SessionCache, type SessionEntry } from '../sessionCache';
import type { TerminalConnectionState } from './types';

type WsMessageContext = {
  id: string;
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

type Endpoint = { serverIp: string; port: string };

type SocketCursor = {
  sessionId: string;
  sinceId: number;
  cols: number;
  rows: number;
};

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

export function terminalSocketUrl(endpoint: Endpoint, cursor: SocketCursor): string {
  return wsUrl(endpoint.serverIp, endpoint.port, cursor);
}

/** Applies one parsed wire message using explicit side effects, without React state closures. */
export function applyWsMessage({
  id,
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
      rows.map((row) => (row.id === id ? { ...row, auto_title: title } : row)),
    );
    return;
  }
  if (payload.type === 'activity') {
    const activity = payload.activity as SessionActivity;
    onDrawerSessions((rows) => rows.map((row) => (row.id === id ? { ...row, activity } : row)));
    onWaitingSessions([{ id, status: 'running', last_output_at: null, activity }]);
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
