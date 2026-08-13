import { writeClipboard } from '../clipboard';
import { notify as sendNativeNotification } from '../desktopNotify';
import { isDesktop } from '../platform';
import type { DrawerSession } from '../SessionDrawer';
import type { SessionCache, SessionEntry } from '../sessionCache';
import { sessionLabel } from '../sessionLabel';
import type { TerminalViewHandle } from '../TerminalView.types';
import { TerminalEngine } from '../terminalEngine';
import type { OutputBatcher } from '../terminalRendererProtocol';
import type { HostClient } from './hostClient';
import type { HostProfile } from './hostStore';
import { applyPageControl, type PageControlEvent } from './pageControlState';
import {
  applyWsMessage,
  backoffDelay,
  focusFrame,
  maybeNotify,
  parseSessionKey,
  retryAfterClose,
  scheduleReconnect,
  statusAfterClose,
} from './terminalSessionLogic';
import type { ConnectionStatus, TerminalConnectionState } from './types';

export type SessionHandoff = { key: string; chunks: string[]; bufferOnly?: boolean };

export type SessionTransportBag = {
  connections: Map<string, TerminalConnectionState>;
  cache: SessionCache;
  clientRef: { current: HostClient };
  profiles: HostProfile[];
  clientFor: (profile: HostProfile) => HostClient;
  activeKeyRef: { current: string };
  dimsRef: { current: { numCols: number; numRows: number } };
  readyRef: { current: boolean };
  connectionStatusRef: { current: ConnectionStatus };
  windowFocusedRef: { current: boolean };
  notificationsEnabledRef: { current: boolean };
  drawerSessionsRef: { current: DrawerSession[] };
  appStateRef: { current: string };
  handoffRef: { current: SessionHandoff | null };
  terminalViewRef: { current: TerminalViewHandle | null };
  outputBatcher: OutputBatcher;
  setConnectionStatus: (
    value: ConnectionStatus | ((current: ConnectionStatus) => ConnectionStatus),
  ) => void;
  setHasConnected: (value: boolean) => void;
  setGitSummaryVersion: (update: (version: number) => number) => void;
  setTerminalMetadataVersion: (update: (version: number) => number) => void;
  setDrawerSessions: (update: (previous: DrawerSession[]) => DrawerSession[]) => void;
  notifyWaitingSessions: (rows: DrawerSession[]) => void;
  theme: { terminal: { fg: string; bg: string }; keyboardAppearance: 'light' | 'dark' };
  fontFamily: string;
  fontSize: number;
};

export function resolveClientForKey(bag: SessionTransportBag, key: string): HostClient {
  const { hostId } = parseSessionKey(key);
  if (hostId === bag.clientRef.current.profile.id) return bag.clientRef.current;
  const cached = bag.connections.get(key)?.client;
  if (cached) return cached;
  const profile = bag.profiles.find((candidate) => candidate.id === hostId);
  return profile ? bag.clientFor(profile) : bag.clientRef.current;
}

export function ensureConnState(bag: SessionTransportBag, key: string): TerminalConnectionState {
  let state = bag.connections.get(key);
  if (!state) {
    state = {
      client: resolveClientForKey(bag, key),
      sock: null,
      gen: 0,
      open: false,
      reconnectTimeout: null,
      retry: 0,
      ping: null,
      lastSeen: 0,
      openedAt: 0,
    };
    bag.connections.set(key, state);
  }
  return state;
}

export function cachedEntry(bag: SessionTransportBag, key: string): SessionEntry {
  return bag.cache.touch(key, () => {
    const { numCols: cols, numRows: rows } = bag.dimsRef.current;
    const term = new TerminalEngine(cols || 80, rows || 24);
    // The full xterm renderer owns user input and terminal-generated replies.
    // Headless xterm remains the background metadata/serialization model.
    term.onReply = null;
    term.onClipboardWrite = (text) => {
      // Background tabs stay live — an OSC 52 from a hidden session must not
      // silently overwrite the device clipboard while the user is elsewhere.
      if (key === bag.activeKeyRef.current) void writeClipboard(text).catch(() => {});
    };
    return {
      term,
      sinceId: 0,
      lastAppliedId: 0,
      diffSummary: { files: [] },
      repoStatus: {
        branch: '',
        shortSha: '',
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
      },
      lastBellCount: 0,
      lastNotifyCount: 0,
    };
  });
}

export function sendActiveJson(bag: SessionTransportBag, object: unknown): void {
  const state = bag.connections.get(bag.activeKeyRef.current);
  if (state?.open && state.sock) state.sock.send(JSON.stringify(object));
}

export function sendFocus(bag: SessionTransportBag, focused: boolean): void {
  sendActiveJson(bag, focusFrame(focused));
}

export function hydrateRenderer(bag: SessionTransportBag, key = bag.activeKeyRef.current): void {
  const entry = cachedEntry(bag, key);
  bag.outputBatcher.clear();
  void bag.terminalViewRef.current?.hydrate(
    entry.term.serialize(),
    entry.term.cols,
    entry.term.rows,
    {
      foreground: bag.theme.terminal.fg,
      background: bag.theme.terminal.bg,
      keyboardAppearance: bag.theme.keyboardAppearance,
    },
    bag.fontFamily,
    bag.fontSize,
    entry.term.getPromptLines(),
  );
}

export function disconnectSession(bag: SessionTransportBag, key: string): void {
  const state = bag.connections.get(key);
  if (!state) return;
  if (state.reconnectTimeout) clearTimeout(state.reconnectTimeout);
  if (state.ping) clearInterval(state.ping);
  state.gen++;
  state.open = false;
  state.sock?.close();
  bag.connections.delete(key);
  if (key === bag.activeKeyRef.current) bag.setConnectionStatus('disconnected');
}

export function disconnectAllSessions(bag: SessionTransportBag): void {
  for (const key of Array.from(bag.connections.keys())) disconnectSession(bag, key);
}

function onSocketOpen(
  bag: SessionTransportBag,
  key: string,
  state: TerminalConnectionState,
  generation: number,
): void {
  if (state.gen !== generation) return;
  state.open = true;
  // Opening is not proof of health — a socket killed mid-replay opens too.
  // retryAfterClose() clears the counter only once the connection has stayed up,
  // so a flapping socket keeps backing off.
  state.openedAt = Date.now();
  const reportFocus = (focused: boolean) =>
    queueMicrotask(() => {
      if (state.gen === generation) state.sock?.send(JSON.stringify(focusFrame(focused)));
    });
  if (key === bag.activeKeyRef.current) {
    bag.setHasConnected(true);
    bag.setConnectionStatus('connected');
    // A fresh connection is focused unless the app is known to be backgrounded.
    // AppState.currentState can be 'unknown' before the first transition, and
    // treating that as unfocused would silence notifications for the session
    // the user is looking at.
    reportFocus(bag.appStateRef.current !== 'background' && bag.appStateRef.current !== 'inactive');
  } else reportFocus(false);
  state.lastSeen = Date.now();
  if (state.ping) clearInterval(state.ping);
  state.ping = setInterval(() => {
    if (Date.now() - state.lastSeen > 30_000)
      try {
        state.sock?.close();
      } catch {}
  }, 15_000);
}

function onSocketClose(
  bag: SessionTransportBag,
  key: string,
  state: TerminalConnectionState,
  generation: number,
  connect: (nextKey: string) => void,
): void {
  if (state.gen !== generation) return;
  state.open = false;
  if (state.ping) {
    clearInterval(state.ping);
    state.ping = null;
  }
  if (bag.connectionStatusRef.current === 'auth-failed') {
    state.retry = 0;
    return;
  }
  bag.setConnectionStatus((current) => statusAfterClose(bag.activeKeyRef.current, key, current));
  state.retry = retryAfterClose(state, Date.now());
  if (bag.cache.has(key))
    state.reconnectTimeout = scheduleReconnect({
      id: key,
      readyRef: bag.readyRef,
      delay: backoffDelay(state.retry++),
      schedule: setTimeout,
      reconnect: connect,
    });
}

export function handleWsMessage(bag: SessionTransportBag, key: string, data: string): void {
  const { sessionId, hostId } = parseSessionKey(key);
  try {
    applyWsMessage({
      id: key,
      drawerSessionId: sessionId,
      drawerHostId: hostId,
      message: JSON.parse(data),
      entry: bag.cache.get(key),
      activeId: bag.activeKeyRef.current,
      onGitSummaryChanged: () => bag.setGitSummaryVersion((version) => version + 1),
      onTerminalMetadataChanged: () => bag.setTerminalMetadataVersion((version) => version + 1),
      onDrawerSessions: (update) =>
        bag.setDrawerSessions((previous) => {
          const next = update(previous);
          bag.drawerSessionsRef.current = next;
          return next;
        }),
      onWaitingSessions: bag.notifyWaitingSessions,
      onOutput: (sessionKey, chunk) => {
        const handoff = bag.handoffRef.current;
        if (handoff && sessionKey === handoff.key) {
          handoff.chunks.push(chunk);
          // Theme repaint holds bytes off the page until hydrate finishes.
          if (handoff.bufferOnly) return;
        }
        bag.outputBatcher.push(sessionKey, chunk);
      },
      onNotify: (sessionKey, session) =>
        maybeNotify({
          id: sessionKey,
          entry: session,
          activeId: bag.activeKeyRef.current,
          windowFocused: bag.windowFocusedRef.current,
          notificationsEnabled: bag.notificationsEnabledRef.current,
          isDesktop,
          label: sessionLabel(
            bag.drawerSessionsRef.current.find(
              (row) => row.id === sessionId && row.hostId === hostId,
            ) ?? { id: sessionId },
          ),
          notify: (title, body) => void sendNativeNotification(title, body),
        }),
      hydrateRenderer: (id) => hydrateRenderer(bag, id),
    });
  } catch (error) {
    console.error('ws message error:', error);
  }
}

export function connectSession(bag: SessionTransportBag, key: string): void {
  // disconnect() drops the state object, so the escalating retry count has to
  // be carried across explicitly — otherwise every reconnect starts from 0
  // and backoff never engages.
  const carriedRetry = bag.connections.get(key)?.retry ?? 0;
  disconnectSession(bag, key);
  const { sessionId } = parseSessionKey(key);
  const entry = cachedEntry(bag, key);
  const state = ensureConnState(bag, key);
  state.retry = carriedRetry;
  state.client = resolveClientForKey(bag, key);
  if (key === bag.activeKeyRef.current) bag.setConnectionStatus('connecting');
  const generation = ++state.gen;
  try {
    state.sock = state.client.openSocket(
      '/api/ws',
      {
        sessionId,
        sinceId: entry.sinceId,
        cols: bag.dimsRef.current.numCols,
        rows: bag.dimsRef.current.numRows,
      },
      {
        onOpen: () => onSocketOpen(bag, key, state, generation),
        onMessage: (data) => {
          if (state.gen !== generation) return;
          state.lastSeen = Date.now();
          handleWsMessage(bag, key, data);
        },
        onClose: () =>
          onSocketClose(bag, key, state, generation, (next) => connectSession(bag, next)),
      },
    );
  } catch {
    state.open = false;
    if (key === bag.activeKeyRef.current) bag.setConnectionStatus('disconnected');
  }
}

export async function repaintActiveFromPage(bag: SessionTransportBag): Promise<void> {
  const key = bag.activeKeyRef.current;
  const entry = bag.cache.get(key);
  if (!entry) return;
  // Don't nest under an in-flight session-switch handoff.
  if (bag.handoffRef.current) return;
  // Flush pending paints into the page so serialize includes them.
  bag.outputBatcher.flushNow();
  const handoff: SessionHandoff = { key, chunks: [], bufferOnly: true };
  bag.handoffRef.current = handoff;
  try {
    let data = entry.term.serialize();
    let promptLines = entry.term.getPromptLines();
    try {
      const live = await bag.terminalViewRef.current?.serialize();
      if (live) {
        data = live.data;
        promptLines = live.promptLines;
      }
    } catch {
      // page unavailable — fall back to shadow
    }
    const trailing = handoff.chunks.splice(0, handoff.chunks.length);
    if (trailing.length) data += trailing.join('');
    if (key !== bag.activeKeyRef.current) return;
    await bag.terminalViewRef.current?.hydrate(
      data,
      entry.term.cols,
      entry.term.rows,
      {
        foreground: bag.theme.terminal.fg,
        background: bag.theme.terminal.bg,
        keyboardAppearance: bag.theme.keyboardAppearance,
      },
      bag.fontFamily,
      bag.fontSize,
      promptLines,
    );
    while (handoff.chunks.length > 0) {
      const more = handoff.chunks.splice(0, handoff.chunks.length);
      bag.terminalViewRef.current?.write(more.join(''));
    }
  } finally {
    if (bag.handoffRef.current === handoff) bag.handoffRef.current = null;
  }
}

export function handlePageControl(
  bag: SessionTransportBag,
  event: PageControlEvent,
  bumpMetadata: () => void,
): void {
  const key = bag.activeKeyRef.current;
  const entry = bag.cache.get(key);
  if (!entry) return;
  const effect = applyPageControl(entry, event);
  if (effect === 'metadata') bumpMetadata();
  if (effect !== 'notify') return;
  const { sessionId, hostId } = parseSessionKey(key);
  maybeNotify({
    id: key,
    entry,
    activeId: bag.activeKeyRef.current,
    windowFocused: bag.windowFocusedRef.current,
    notificationsEnabled: bag.notificationsEnabledRef.current,
    isDesktop,
    label: sessionLabel(
      bag.drawerSessionsRef.current.find(
        (row) => row.id === sessionId && row.hostId === hostId,
      ) ?? {
        id: sessionId,
      },
    ),
    notify: (title, body) => void sendNativeNotification(title, body),
  });
}

export function applyRendererResize(bag: SessionTransportBag, cols: number, rows: number): void {
  // FitAddon already coalesces; PTY resize must follow in the same tick.
  if (bag.dimsRef.current.numCols === cols && bag.dimsRef.current.numRows === rows) return;
  bag.dimsRef.current = { numCols: cols, numRows: rows };
  bag.cache.get(bag.activeKeyRef.current)?.term.resize(cols, rows);
  sendActiveJson(bag, { type: 'resize', cols, rows });
}
