import type { SessionActivity } from '../activity';
import type { DiffFileStat } from '../diffModel';
import { parseRepoStatus } from '../gitStatusModel';
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

/**
 * A connection only counts as healthy once it has *stayed* open. Resetting the
 * retry counter in onOpen made backoff unreachable for a socket that opens and
 * dies immediately (e.g. killed by an oversized replay), turning reconnect into
 * a hot loop that hammered the server. Anything shorter than this threshold is
 * treated as a failed attempt and keeps escalating the delay.
 */
export const HEALTHY_CONNECTION_MS = 10_000;

/** Retry count to use for the next reconnect after a socket closed. */
export function retryAfterClose(
  state: Pick<TerminalConnectionState, 'retry' | 'openedAt'>,
  now: number,
  healthyMs = HEALTHY_CONNECTION_MS,
): number {
  const lived = state.openedAt > 0 ? now - state.openedAt : 0;
  return state.openedAt > 0 && lived >= healthyMs ? 0 : state.retry;
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

function applyOutputMessage(ctx: WsMessageContext, payload: Record<string, unknown>): void {
  const { id, entry, activeId, onOutput, onNotify } = ctx;
  if (!entry || typeof payload.id !== 'number' || payload.id <= entry.lastAppliedId) return;
  const chunk = payload.chunk;
  if (typeof chunk !== 'string') return;
  entry.lastAppliedId = payload.id;
  entry.sinceId = payload.id;
  // Active session: the page (WebView / desktop xterm) is the sole parser.
  // Feeding the headless shadow too doubles Hermes work for every byte.
  if (id === activeId) {
    onOutput(id, chunk);
    return;
  }
  entry.term.write(chunk, () => {
    onNotify(id, entry);
    onOutput(id, chunk);
  });
}

function applyExitMessage(ctx: WsMessageContext, payload: Record<string, unknown>): void {
  const { id, entry, activeId, onOutput } = ctx;
  if (!entry) return;
  const code = typeof payload.exitCode === 'number' ? ` with code ${payload.exitCode}` : '';
  const text = `\r\n\x1b[31m[Process exited${code}]\x1b[0m\r\n`;
  if (id === activeId) {
    onOutput(id, text);
    return;
  }
  entry.term.write(text, () => onOutput(id, text));
}

function applyActivityMessage(ctx: WsMessageContext, payload: Record<string, unknown>): void {
  const activity = payload.activity as SessionActivity;
  const sessionId = ctx.drawerSessionId ?? ctx.id;
  const hostId = ctx.drawerHostId ?? '';
  ctx.onDrawerSessions((rows) =>
    rows.map((row) => (row.id === sessionId && row.hostId === hostId ? { ...row, activity } : row)),
  );
  ctx.onWaitingSessions([
    {
      id: sessionId,
      hostId,
      status: 'running',
      last_output_at: null,
      activity,
    },
  ]);
}

/** Applies one parsed wire message using explicit side effects, without React state closures. */
export function applyWsMessage(ctx: WsMessageContext): void {
  const { id, drawerSessionId = id, drawerHostId = '', message, entry, activeId } = ctx;
  const payload = object(message);
  if (!payload || !entry || typeof payload.type !== 'string') return;
  if (payload.type === 'diff') {
    const summary = object(payload.summary);
    if (!Array.isArray(summary?.files)) return;
    entry.diffSummary = { files: summary.files as DiffFileStat[] };
    const status = parseRepoStatus(payload.status);
    if (status) entry.repoStatus = status;
    if (id === activeId) ctx.onGitSummaryChanged();
    return;
  }
  if (payload.type === 'output') {
    applyOutputMessage({ ...ctx, drawerSessionId, drawerHostId }, payload);
    return;
  }
  if (payload.type === 'exit') {
    applyExitMessage({ ...ctx, drawerSessionId, drawerHostId }, payload);
    return;
  }
  if (payload.type === 'title' && typeof payload.title === 'string') {
    const title = payload.title;
    ctx.onDrawerSessions((rows) =>
      rows.map((row) =>
        row.id === drawerSessionId && row.hostId === drawerHostId
          ? { ...row, auto_title: title }
          : row,
      ),
    );
    return;
  }
  if (payload.type === 'activity') {
    applyActivityMessage({ ...ctx, drawerSessionId, drawerHostId }, payload);
    return;
  }
  if (payload.type === 'reset') {
    entry.term.reset();
    entry.sinceId = 0;
    entry.lastAppliedId = 0;
    entry.lastBellCount = 0;
    entry.lastNotifyCount = 0;
    if (id === activeId) ctx.hydrateRenderer(id);
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
