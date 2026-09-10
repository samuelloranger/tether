import type { AgentMessageRow } from './agentMessages';
import { type AgentRegistry, sharedAgentRegistry } from './agentRegistry';
import { applyAgentMessage, defaultGetAgentMessages } from './agentReplay';
import { type AgentUsageLimits, fetchAgentUsage } from './agentUsage';
import {
  type ClaudeSessionMeta,
  listClaudeSessions,
  sessionJsonlPath,
  type TranslatedMessage,
  translateSessionJsonl,
} from './claudeSessions';
import { getSession } from './db';
import type { AuthDevice } from './deviceRegistry';
import { listDevices, RegistryError, resolveTarget, revokeDevice } from './deviceRegistry';
import { mintToken as mintDeviceToken } from './deviceToken';
import { logError } from './log';
import type { FrameIO, ServerChannel } from './noiseChannel';
import {
  type FocusSubscriber,
  getActiveSession,
  kickPtySize,
  resizeSession,
  SessionExitedError,
  setSessionFocus,
  startSession,
  subscribeToSession,
  writeToSession,
} from './pty';
import { REPLAY_BYTE_BUDGET, replayOutputFrames } from './replayPlan';
import { getReplayLogs as readReplayLogs } from './replayRead';
import { testEvent } from './testEvents';

/**
 * The identity of the device on the far end of this Noise session — already
 * authorized by the IK reconnect (`authGate.runReconnect`) before this loop
 * runs. Threaded in so `devices.list` can flag the caller's own row (`isSelf`).
 */
export interface SessionIdentity {
  deviceId: string;
}

/**
 * The dependencies the Noise session loop drives: the `pty.ts` subset (so the
 * loop is testable without a real PTY/holder) plus the device-registry functions
 * that back the `devices.list` / `devices.revoke` control messages, and the
 * authenticated caller identity. All default to the live implementations, so
 * existing callers/tests that only override the PTY subset are unaffected.
 */
export interface SessionDeps {
  startSession: typeof startSession;
  subscribeToSession: typeof subscribeToSession;
  writeToSession: typeof writeToSession;
  resizeSession: typeof resizeSession;
  setSessionFocus: typeof setSessionFocus;
  kickPtySize: typeof kickPtySize;
  isSessionLive: (id: string) => boolean;
  /** Byte-bounded catch-up for a Noise `start` that carries `sinceId`. */
  getReplayLogs: (
    sessionId: string,
    sinceId: number,
  ) => { reset: boolean; logs: Array<{ id: number; chunk: string }> };
  listDevices: typeof listDevices;
  revokeDevice: typeof revokeDevice;
  resolveTarget: typeof resolveTarget;
  identity: SessionIdentity;
  mintToken?: (deviceId: string) => { token: string; expiresAt: string };
  /**
   * Server-owned, shared across every Noise connection — agent sessions must
   * outlive a client disconnect. Injectable so tests get an isolated registry
   * (and a fake driver) without touching the real `sharedAgentRegistry`.
   */
  agentRegistry?: AgentRegistry;
  /** Catch-up for an `agent.start` that carries `sinceSeq` — mirrors getReplayLogs. */
  getAgentMessages: (sessionId: string, sinceSeq: number) => AgentMessageRow[];
  /** Account 5h/7day usage for the `agent.status` frame; null = unavailable. */
  fetchAgentUsage: () => Promise<AgentUsageLimits | null>;
  /** Past Claude Code sessions under this cwd (`/resume` picker). */
  listClaudeSessions: (cwd: string) => ClaudeSessionMeta[];
  /** Translate a past Claude session's transcript into stored rows (`/resume`). */
  translateClaudeSession: (claudeSessionId: string, cwd: string) => TranslatedMessage[];
}

function defaultGetReplayLogs(sessionId: string, sinceId: number) {
  const plan = readReplayLogs(sessionId, sinceId, REPLAY_BYTE_BUDGET);
  const sess = getSession(sessionId);
  const pruned = sinceId > 0 && sess !== null && sinceId < sess.pruned_before;
  return { reset: plan.reset || pruned, logs: plan.logs };
}

function defaultMintToken(deviceId: string): { token: string; expiresAt: string } {
  const token = mintDeviceToken(deviceId);
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()) as {
    exp: number;
  };
  return { token, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

const defaultDeps: SessionDeps = {
  startSession,
  subscribeToSession,
  writeToSession,
  resizeSession,
  setSessionFocus,
  kickPtySize,
  isSessionLive: (id) => getActiveSession(id) !== undefined,
  getReplayLogs: defaultGetReplayLogs,
  listDevices,
  revokeDevice,
  resolveTarget,
  identity: { deviceId: '' },
  mintToken: defaultMintToken,
  agentRegistry: sharedAgentRegistry,
  getAgentMessages: defaultGetAgentMessages,
  fetchAgentUsage: () => fetchAgentUsage(),
  listClaudeSessions: (cwd) => listClaudeSessions(cwd),
  translateClaudeSession: (id, cwd) => translateSessionJsonl(sessionJsonlPath(cwd, id)),
};

/** Client -> server application messages, after Noise decryption + JSON parse. */
type ClientMessage =
  | { t: 'start'; id: string; command?: string; cols?: number; rows?: number; sinceId?: number }
  | { t: 'input'; id: string; text: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'focus'; id: string; focused: boolean }
  | { t: 'devices.list' }
  | { t: 'devices.revoke'; target: string }
  | { t: 'auth.token' }
  | { t: 'agent.start'; id: string; cwd: string; sinceSeq?: number; resumeClaudeSessionId?: string }
  | { t: 'agent.prompt'; text: string }
  | { t: 'agent.model'; name: string }
  | { t: 'agent.list-sessions'; cwd: string }
  | { t: 'agent.interrupt' };

/** One row of the `devices` reply — the wire shape an iOS client mirrors. */
interface DeviceListItem {
  id: string;
  label: string;
  fingerprint: string;
  pairedAt: string;
  lastSeenAt: string | null;
  lastAddress: string | null;
  isSelf: boolean;
}

function toListItem(device: AuthDevice, selfId: string): DeviceListItem {
  return {
    id: device.id,
    label: device.label,
    fingerprint: device.fingerprint,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    lastAddress: device.lastAddress,
    isSelf: device.id === selfId,
  };
}

interface Attachment {
  unsub: () => void;
  sub: FocusSubscriber;
}

/**
 * Per-channel agent-chat state: the registry driving this channel's agent
 * sessions, their sink unsubscribes (for teardown), and the id `agent.prompt` /
 * `agent.interrupt` apply to — those messages carry no id of their own, so we
 * track the most recently `agent.start`ed one (mirrors the PTY's per-id
 * tracking, but agent-chat is one-active-session-per-channel).
 */
export interface AgentState {
  registry: AgentRegistry;
  attachments: Map<string, () => void>;
  currentId: string | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Keep each sealed `output` frame's plaintext well under the FFI transport
// buffer so a fat PTY chunk never overflows it. An overflow would fail the seal
// AFTER the nonce advanced, desyncing the cipher — so we chunk, and also treat
// any seal/send failure as fatal (below).
const MAX_OUTPUT_CHARS = 16 * 1024;

function sendOutputChunks(
  sendSealed: (obj: unknown) => boolean,
  id: number,
  chunk: string,
): boolean {
  for (let i = 0; i < chunk.length; i += MAX_OUTPUT_CHARS) {
    if (
      !sendSealed({
        t: 'output',
        chunk: chunk.slice(i, i + MAX_OUTPUT_CHARS),
        id,
      })
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Handle the device-management control messages (`devices.list` /
 * `devices.revoke`). Both ride the already-authenticated Noise channel, so the
 * caller is a paired device — CLI parity: any paired device may manage devices.
 * A revoke against a bad target replies `ok:false` with a friendly error and
 * NEVER throws out of the loop (so a mistyped target can't tear the session
 * down). Self-revoke is not blocked (CLI parity); `isSelf` only marks the row.
 */
function applyDevicesMessage(
  msg: { t: 'devices.list' } | { t: 'devices.revoke'; target: string },
  d: SessionDeps,
  sendSealed: (obj: unknown) => boolean,
): void {
  if (msg.t === 'devices.list') {
    const items = d.listDevices().map((device) => toListItem(device, d.identity.deviceId));
    sendSealed({ t: 'devices', items });
    return;
  }
  // devices.revoke
  try {
    d.resolveTarget(msg.target); // resolve first so a bad target yields a clean error
    d.revokeDevice(msg.target);
    sendSealed({ t: 'devices.revoked', target: msg.target, ok: true });
  } catch (err) {
    const error =
      err instanceof RegistryError ? friendlyRegistryError(err) : 'Could not revoke that device.';
    if (!(err instanceof RegistryError)) {
      logError(`Noise session: devices.revoke('${msg.target}') failed:`, err);
    }
    sendSealed({ t: 'devices.revoked', target: msg.target, ok: false, error });
  }
}

/** Map a RegistryError code to a short human string for the client UI. */
function friendlyRegistryError(err: RegistryError): string {
  if (err.code === 'not_found') return 'No device matches that target.';
  if (err.code === 'ambiguous') return 'That target matches more than one device.';
  return 'Could not revoke that device.';
}

/** Apply one decoded client message to the PTY. Extracted to keep the loop small. */
async function applyMessage(
  msg: ClientMessage,
  d: SessionDeps,
  attachments: Map<string, Attachment>,
  makeSubscriber: (id: string) => FocusSubscriber,
  sendSealed: (obj: unknown) => boolean,
  agent: AgentState,
): Promise<void> {
  if (msg.t === 'start') {
    const cols = msg.cols ?? 80;
    const rows = msg.rows ?? 24;
    // A switch-back reattaches to a PTY that is already running. The fit does
    // not move (so recomputeSize stays silent). SIGWINCH is a no-op when the
    // TUI is idle, so a client that sends sinceId also gets a log replay.
    // Old clients omit sinceId and keep the SIGWINCH-only path.
    const wasLive = d.isSessionLive(msg.id);
    try {
      await d.startSession(msg.id, msg.command, cols, rows);
    } catch (err) {
      if (err instanceof SessionExitedError) {
        // The session exited on its own; surface that instead of resurrecting
        // it, so the client shows it stopped rather than a fresh shell.
        sendSealed({ t: 'exit', id: msg.id });
        return;
      }
      logError(`Noise session: startSession('${msg.id}') failed:`, err);
      return;
    }
    attachments.get(msg.id)?.unsub(); // replace any prior subscription (a re-start)

    const sinceId =
      typeof msg.sinceId === 'number' && Number.isFinite(msg.sinceId) ? msg.sinceId : undefined;
    if (sinceId !== undefined) {
      const plan = d.getReplayLogs(msg.id, sinceId);
      if (plan.reset && !sendSealed({ t: 'reset', id: msg.id })) return;
      for (const frame of replayOutputFrames(plan.logs)) {
        if (!sendOutputChunks(sendSealed, frame.id, frame.chunk)) return;
      }
      testEvent('replay', {
        session: msg.id,
        count: plan.logs.length,
        bytes: plan.logs.reduce((n, log) => n + Buffer.byteLength(log.chunk), 0),
        reset: plan.reset,
      });
    }

    const sub = makeSubscriber(msg.id);
    const unsub = d.subscribeToSession(msg.id, sub, cols, rows);
    attachments.set(msg.id, { unsub, sub });
    if (wasLive) d.kickPtySize(msg.id);
    testEvent('noise_start', { session: msg.id, wasLive, cols, rows, sinceId: sinceId ?? null });
  } else if (msg.t === 'input') {
    testEvent('noise_input', { session: msg.id, bytes: msg.text.length });
    d.writeToSession(msg.id, msg.text);
  } else if (msg.t === 'resize') {
    // resizeSession keys the PTY-fit off the exact subscriber object, so only
    // resize a session this channel actually subscribed to.
    const attachment = attachments.get(msg.id);
    if (attachment) {
      testEvent('noise_resize', { session: msg.id, cols: msg.cols, rows: msg.rows });
      d.resizeSession(msg.id, attachment.sub, msg.cols, msg.rows);
    }
  } else if (msg.t === 'focus') {
    const attachment = attachments.get(msg.id);
    if (attachment && typeof msg.focused === 'boolean') {
      testEvent('noise_focus', { session: msg.id, focused: msg.focused });
      d.setSessionFocus(msg.id, attachment.sub, msg.focused);
    }
  } else if (msg.t === 'devices.list' || msg.t === 'devices.revoke') {
    applyDevicesMessage(msg, d, sendSealed);
  } else if (msg.t === 'auth.token') {
    const mint = d.mintToken ?? defaultMintToken;
    const { token, expiresAt } = mint(d.identity.deviceId);
    sendSealed({ t: 'auth.token', token, expiresAt });
  } else if (
    msg.t === 'agent.start' ||
    msg.t === 'agent.prompt' ||
    msg.t === 'agent.model' ||
    msg.t === 'agent.list-sessions' ||
    msg.t === 'agent.interrupt'
  ) {
    await applyAgentMessage(msg, d, sendSealed, agent);
  }
}

/**
 * The application protocol that runs OVER an already-established `ServerChannel`
 * (the Noise handshake + authorization happened before this is called). It is a
 * sealed mirror of the bearer-authed `/api/ws` terminal protocol: `start`
 * spawns/attaches a session and streams its output back sealed, `input` writes
 * keystrokes, `resize` refits the PTY, `focus` suppresses push while attached.
 * The PTY subset matches REST, but subscribers here start unfocused — a Noise
 * session is a background channel until the client sends `{t:'focus', focused:true}`;
 * REST `/api/ws` marks its sole subscriber focused on attach.
 *
 * Every server->client frame is `channel.seal(JSON.stringify(...))`; every
 * client->server frame is `JSON.parse(channel.open(wire))`. The loop ends — and
 * unsubscribes — on a decrypt/parse error or when `io.recv()` rejects (socket
 * closed). It never throws to the caller.
 */
export async function runNoiseSession(
  channel: ServerChannel,
  io: FrameIO,
  deps: Partial<SessionDeps> = {},
): Promise<void> {
  const d: SessionDeps = { ...defaultDeps, ...deps };
  // One attachment per session id opened on this channel.
  const attachments = new Map<string, Attachment>();
  // The registry is server-owned (shared across connections) — only this
  // channel's attachments/currentId are per-connection state.
  const agent: AgentState = {
    registry: d.agentRegistry ?? sharedAgentRegistry,
    attachments: new Map<string, () => void>(),
    currentId: null,
  };

  // A seal advances the Noise nonce; if the seal or send then fails, the cipher
  // is desynced and NOTHING more may be sent on this channel. So a failure is
  // fatal: it resolves `fatal`, which unblocks the recv loop to tear down.
  let fatalErr: Error | null = null;
  let signalFatal: () => void = () => {};
  const fatal = new Promise<void>((resolve) => {
    signalFatal = resolve;
  });

  const cleanup = () => {
    for (const a of attachments.values()) {
      try {
        a.unsub();
      } catch {}
    }
    attachments.clear();
    // Detach only — never kill. The agent (and its underlying `claude`
    // process) is server-owned and must survive this connection closing;
    // another connection may still be attached, or this one may reconnect.
    for (const unsub of agent.attachments.values()) {
      try {
        unsub();
      } catch {}
    }
    agent.attachments.clear();
  };

  // Returns false (and trips fatal) on any seal/send failure — callers must stop.
  const sendSealed = (obj: unknown): boolean => {
    if (fatalErr) return false;
    try {
      io.send(channel.seal(encoder.encode(JSON.stringify(obj))));
      return true;
    } catch (err) {
      fatalErr = err instanceof Error ? err : new Error(String(err));
      logError('Noise session: seal/send failed — tearing down (cipher desync risk):', err);
      signalFatal();
      return false;
    }
  };

  const makeSubscriber = (id: string): FocusSubscriber => {
    const onData: FocusSubscriber = (data) => {
      if (data.type === 'output') {
        sendOutputChunks(sendSealed, data.id, data.chunk);
      } else if (data.type === 'exit') {
        sendSealed({ t: 'exit', id, exitCode: data.exitCode });
      }
    };
    onData.focused = false;
    return onData;
  };

  try {
    for (;;) {
      // Race the next inbound frame against a fatal seal/send failure so the
      // loop tears down even while blocked on recv().
      const next = await Promise.race([
        io.recv().then((frame) => ({ frame }) as const),
        fatal.then(() => ({ fatal: true }) as const),
      ]);
      if ('fatal' in next) return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(decoder.decode(channel.open(next.frame))) as ClientMessage;
      } catch (err) {
        // A frame we can't decrypt or parse means the stream is unusable.
        logError('Noise session: decrypt/parse failed, ending session:', err);
        return;
      }
      await applyMessage(msg, d, attachments, makeSubscriber, sendSealed, agent);
    }
  } catch {
    // io.recv() rejected (socket closed) — fall through to cleanup.
  } finally {
    cleanup();
  }
}
