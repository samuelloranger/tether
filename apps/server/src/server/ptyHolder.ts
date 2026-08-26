import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Socket } from 'bun';
import { getConfig } from './config';
import { CwdRefreshGate } from './cwdRefresh';
import { addTerminalLog, clearInsertCount, deleteSession, getSession, upsertSession } from './db';
import { type DiffSummary, EMPTY_DIFF_SUMMARY } from './gitDiff';
import { findGitRoot } from './gitRoot';
import { EMPTY_REPO_STATUS, type RepoStatus } from './gitStatus';
import { GitWatch } from './gitWatch';
import {
  decodeHolderFrame,
  decodeLegacyHolderLine,
  encodeHolderCwdRequest,
  encodeHolderInput,
  encodeHolderKill,
  encodeHolderResize,
  encodeLegacyHolderFrame,
  type HolderDialect,
  type HolderMessage,
  sniffDialect,
  takeLegacyLines,
} from './holderFrame';
import { clearLiveCwd, getLiveCwd, recordChunk, reportCwd } from './liveCwd';
import { logError, logInfo } from './log';
import type { NotificationEvent } from './notifications';
import { CONFIG_DIR } from './paths';
import { FrameDecoder } from './proto/frame';
import type { Dims } from './ptyResize';
import { buildPushContent, sendPush } from './push';
import { type Activity, clearActivity, recordOutputEvent } from './sessionActivity';
import { autoTitle, clearTitle, getOscTitle, recordTitleChunk } from './sessionTitle';

export const HOLDERS_DIR = path.join(CONFIG_DIR, 'holders');
mkdirSync(HOLDERS_DIR, { recursive: true, mode: 0o700 });
try {
  chmodSync(HOLDERS_DIR, 0o700);
} catch {}

export const sockPathFor = (id: string) => path.join(HOLDERS_DIR, `${id}.sock`);

export type SessionFrame =
  | { type: 'output'; chunk: string; id: number }
  | { type: 'exit'; exitCode?: number }
  | { type: 'diff'; summary: DiffSummary; status?: RepoStatus }
  | { type: 'title'; title: string }
  | { type: 'activity'; activity: Activity };

export type Subscriber = (data: SessionFrame) => void;
export type FocusSubscriber = Subscriber & { focused?: boolean };

export interface SessionInstance {
  sock: Socket;
  /** Framing state for this holder link — see negotiation notes on HolderLink. */
  link: HolderLink;
  subscribers: Set<FocusSubscriber>;
  diffSummary: DiffSummary;
  repoStatus: RepoStatus;
  gitWatch: GitWatch;
  // Each attached client's requested dims. A PTY has one size, so a shared session
  // is fit to the SMALLEST attached client (tmux model): content fits everyone and
  // a larger client just gets blank margin. Recomputed on attach/resize/detach.
  clientDims: Map<FocusSubscriber, { cols: number; rows: number }>;
  // The size the holder was last told to use. Null until we have set one (a
  // reattached holder's size is unknown, so the first recompute always sends).
  // Kept so a recompute that lands on the current size can send nothing at all.
  ptyDims: Dims | null;
}

export const instances = new Map<string, SessionInstance>();

// Sessions an explicit kill already deleted. The holder answers `{t:'k'}` with a
// `{t:'x'}` exit frame a moment later, and that handler used to re-`upsertSession`
// the row killSession had just deleted — the closed tab reappeared as 'stopped'
// and only a second kill (no live instance left, so no 'x' frame) stuck.
export const killed = new Set<string>();

export function broadcast(id: string, data: SessionFrame) {
  const inst = instances.get(id);
  if (!inst) return;
  for (const sub of inst.subscribers) {
    try {
      sub(data);
    } catch (err) {
      logError(`Error notifying subscriber for session "${id}":`, err);
    }
  }
}

function sessionFocused(id: string): boolean {
  return [...(instances.get(id)?.subscribers ?? [])].some((sub) => sub.focused === true);
}

function notify(id: string, event: NotificationEvent): void {
  if (sessionFocused(id)) return;
  const session = getSession(id);
  const ctx = {
    sessionId: id,
    sessionTitle: autoTitle(getOscTitle(id), getLiveCwd(id), session?.command ?? 'bash'),
  };
  const cfg = getConfig();
  const pushContent = buildPushContent(event, ctx, cfg);
  if (pushContent) void sendPush(pushContent, ctx);
}

/**
 * Per-connection state for one holder link, including which framing dialect the
 * holder on the other end speaks.
 *
 * Holders are detached processes, so a server that has just been updated will
 * find holders still running the pre-v2 newline-JSON code. Adopting them is not
 * optional: a user with a running shell must not lose it to a server update.
 *
 * Negotiation is one byte. A v2 holder sends HELLO the moment we connect; the
 * legacy dialect's frames are JSON objects, so they always start with `{`, which
 * no binary frame can. Until the first inbound byte arrives, outbound frames are
 * queued rather than guessed at — sending binary to a legacy holder would drop a
 * resize on the floor. Only a legacy holder can be silent on connect (a v2 one
 * always says HELLO), so if nothing arrives we settle on legacy.
 */
type HolderLink = {
  decoder: TextDecoder;
  pendingOutput: string[];
  exited: boolean;
  dialect: HolderDialect | null;
  frames: FrameDecoder;
  lineBuf: string;
  outQueue: HolderMessage[];
  dialectTimer: ReturnType<typeof setTimeout> | null;
  sock: Socket | null;
  /**
   * Cooldown + waiter coalesce for on-demand CWDREQ — see `refreshLiveCwd` and
   * `cwdRefresh.ts`. Legacy holders never touch this; they return at the dialect
   * check before any request is sent.
   */
  cwdRefresh: CwdRefreshGate;
  /** Timer for the single in-flight CWDREQ; cleared when waiters settle. */
  cwdRefreshTimer: ReturnType<typeof setTimeout> | null;
};

/** How long to wait for a holder's first byte before assuming the old dialect. */
export const HOLDER_DIALECT_TIMEOUT_MS = 1000;

function newHolderLink(): HolderLink {
  return {
    decoder: new TextDecoder('utf-8'),
    pendingOutput: [],
    exited: false,
    dialect: null,
    frames: new FrameDecoder(),
    lineBuf: '',
    outQueue: [],
    dialectTimer: null,
    sock: null,
    cwdRefresh: new CwdRefreshGate(),
    cwdRefreshTimer: null,
  };
}

function writeHolderMessage(link: HolderLink, msg: HolderMessage): void {
  if (!link.sock) return;
  if (link.dialect === 'legacy') {
    const line = encodeLegacyHolderFrame(msg);
    if (line) link.sock.write(line);
    return;
  }
  if (msg.type === 'input') link.sock.write(encodeHolderInput(msg.data));
  else if (msg.type === 'resize') link.sock.write(encodeHolderResize(msg.cols, msg.rows));
  else if (msg.type === 'kill') link.sock.write(encodeHolderKill());
  else if (msg.type === 'cwdRequest') link.sock.write(encodeHolderCwdRequest());
}

function settleDialect(link: HolderLink, dialect: HolderDialect): void {
  link.dialect = dialect;
  if (link.dialectTimer) {
    clearTimeout(link.dialectTimer);
    link.dialectTimer = null;
  }
  const queued = link.outQueue;
  link.outQueue = [];
  for (const msg of queued) writeHolderMessage(link, msg);
}

/** Queues until the dialect is known, then writes in it. */
export function sendHolderMessage(id: string, msg: HolderMessage): boolean {
  const link = instances.get(id)?.link;
  if (!link) return false;
  if (link.dialect === null) {
    link.outQueue.push(msg);
    return true;
  }
  try {
    writeHolderMessage(link, msg);
    return true;
  } catch {
    return false;
  }
}

function flushHolderOutput(id: string, link: HolderLink): void {
  if (link.pendingOutput.length === 0) return;
  const text = link.pendingOutput.join('');
  link.pendingOutput = [];
  const cwdReported = recordChunk(id, text);
  const cwd = getLiveCwd(id);
  if (cwdReported) instances.get(id)?.gitWatch.setRoot(cwd ? findGitRoot(cwd) : null);
  const titleChanged = recordTitleChunk(id, text);
  const logId = addTerminalLog(id, text);
  broadcast(id, { type: 'output', chunk: text, id: logId });
  // OSC title set or cleared — push the recomputed display title so attached
  // clients relabel their tab without waiting on the session-list poll.
  if (titleChanged) {
    const title = autoTitle(getOscTitle(id), getLiveCwd(id), getSession(id)?.command ?? 'bash');
    broadcast(id, { type: 'title', title });
  }
  const activityEvent = recordOutputEvent(id, text);
  if (activityEvent.activity) broadcast(id, { type: 'activity', activity: activityEvent.activity });
  if (activityEvent.notify) {
    notify(id, { type: 'oscNotify', ...activityEvent.notify });
  } else if (activityEvent.activity === 'waiting') {
    notify(id, { type: 'waiting' });
  }
  if (activityEvent.longJob) {
    notify(id, { type: 'longJob', seconds: getConfig().longJobSeconds });
  }
}

function handleHolderMessage(id: string, msg: HolderMessage | null, link: HolderLink): void {
  if (!msg) return;
  if (msg.type === 'output') {
    const text = link.decoder.decode(msg.data, { stream: true });
    if (text) link.pendingOutput.push(text);
  } else if (msg.type === 'cwd') {
    if (link.cwdRefreshTimer) {
      clearTimeout(link.cwdRefreshTimer);
      link.cwdRefreshTimer = null;
    }
    link.cwdRefresh.onAnswer(true);
    // A holder-reported cwd (spawn time, or a fresh kernel read on every new
    // client attach) — arms git watching without waiting on an OSC 7 prompt
    // redraw, which may be a long time coming (or never, mid-TUI).
    reportCwd(id, msg.cwd);
    instances.get(id)?.gitWatch.setRoot(findGitRoot(msg.cwd));
  } else if (msg.type === 'exit') {
    link.exited = true;
    // Flush any buffered partial multi-byte sequence the streaming decoder is
    // still holding (PTY died mid-emoji) so the tail isn't silently dropped.
    const tail = link.decoder.decode();
    if (tail) link.pendingOutput.push(tail);
    flushHolderOutput(id, link);
    logInfo(`PTY process for session "${id}" exited with code ${msg.exitCode}`);
    if (killed.delete(id)) {
      deleteSession(id);
    } else {
      const sess = getSession(id);
      upsertSession(id, sess?.command ?? 'bash', 'stopped');
    }
    broadcast(id, { type: 'exit', exitCode: msg.exitCode });
    notify(id, { type: 'exit', exitCode: msg.exitCode });
    instances.get(id)?.gitWatch.dispose();
    instances.get(id)?.subscribers.clear();
    instances.delete(id);
    clearLiveCwd(id);
    clearTitle(id);
    clearInsertCount(id);
    clearActivity(id);
  }
}

/**
 * Feeds inbound holder bytes through whichever dialect this link settled on,
 * choosing it from the first byte if we have not yet.
 */
function readHolderData(id: string, link: HolderLink, buf: Buffer): void {
  if (link.dialect === null && buf.length > 0) settleDialect(link, sniffDialect(buf[0]));
  if (link.dialect === 'legacy') {
    link.lineBuf += buf.toString('utf8');
    const { lines, rest } = takeLegacyLines(link.lineBuf);
    link.lineBuf = rest;
    for (const line of lines) handleHolderMessage(id, decodeLegacyHolderLine(line), link);
  } else {
    try {
      for (const frame of link.frames.push(new Uint8Array(buf))) {
        handleHolderMessage(id, decodeHolderFrame(frame), link);
      }
    } catch (err) {
      // Desynced framing: nothing after this point can be trusted, so drop the
      // link. The holder keeps the PTY alive and the next attach starts clean.
      logError(`Holder link for session "${id}" desynced:`, err);
      link.sock?.end();
      return;
    }
  }
  flushHolderOutput(id, link);
}

function onHolderSocketClose(id: string, link: HolderLink): void {
  // Holder gone without an exit frame = it crashed or was killed hard.
  // Drop the instance so the next startSession spawns a fresh holder.
  const instance = instances.get(id);
  if (!link.exited && instance?.sock) {
    // Notify attached clients before we clear them, else they keep a
    // dead subscription and render a live-looking but stopped terminal.
    for (const sub of instance.subscribers) {
      try {
        sub({ type: 'exit' });
      } catch {}
    }
    instance.subscribers.clear();
    if (instances.delete(id)) {
      instance.gitWatch.dispose();
      clearLiveCwd(id);
      clearTitle(id);
      clearActivity(id);
      logInfo(`Holder link for session "${id}" closed unexpectedly`);
    }
  }
}

// Connect to a session's holder socket and wire its frames into the existing
// log + broadcast pipeline. Resolves once attached; rejects if nothing listens.
export function attach(id: string, sockPath: string = sockPathFor(id)): Promise<SessionInstance> {
  const link = newHolderLink();
  return new Promise((resolve, reject) => {
    let settled = false;
    Bun.connect({
      unix: sockPath,
      socket: {
        open(sock) {
          settled = true;
          link.sock = sock;
          // Only a pre-v2 holder can stay silent on connect; a v2 one answers
          // with HELLO immediately. Waiting is what lets queued frames go out
          // in the right dialect instead of the wrong one.
          link.dialectTimer = setTimeout(() => {
            if (link.dialect === null) settleDialect(link, 'legacy');
          }, HOLDER_DIALECT_TIMEOUT_MS);
          const gitWatch = new GitWatch((summary, status) => {
            const active = instances.get(id);
            if (!active) return;
            active.diffSummary = summary;
            active.repoStatus = status;
            broadcast(id, { type: 'diff', summary, status });
          });
          const instance: SessionInstance = {
            sock,
            link,
            subscribers: new Set(),
            diffSummary: EMPTY_DIFF_SUMMARY,
            repoStatus: EMPTY_REPO_STATUS,
            gitWatch,
            clientDims: new Map(),
            ptyDims: null,
          };
          instances.set(id, instance);
          resolve(instance);
        },
        data(_sock, buf) {
          readHolderData(id, link, buf);
        },
        close() {
          if (link.dialectTimer) clearTimeout(link.dialectTimer);
          onHolderSocketClose(id, link);
        },
        error() {},
      },
    }).catch((err) => {
      if (!settled) reject(err);
    });
  });
}

/** Sends keystrokes/paste to the PTY. */
export function sendHolderInput(id: string, text: string): boolean {
  return sendHolderMessage(id, { type: 'input', data: new TextEncoder().encode(text) });
}

/** Resizes the PTY. */
export function sendHolderResize(id: string, cols: number, rows: number): boolean {
  return sendHolderMessage(id, { type: 'resize', cols, rows });
}

/** Asks the holder to take its PTY down. */
/**
 * Asks the holder to re-read its shell's cwd from the kernel, and waits briefly
 * for the answer.
 *
 * The live cwd otherwise only moves when the prompt emits OSC 7 or when a client
 * attaches, so a shell with a custom `PS1` left the git and file features
 * looking at the directory the session started in no matter where the user went.
 *
 * Deliberately best-effort. It resolves false rather than throwing when there is
 * no holder, when the holder speaks the pre-v2 dialect (which cannot express the
 * request), when a prior ask is still cooling down after a timeout, or when the
 * answer does not arrive in time — the caller then uses the cwd it already had,
 * which is exactly the old behaviour. The point is to be right more often, not
 * to add a way for a diff request to fail.
 *
 * An unanswered request used to latch forever (`cwdRequestUnanswered`); that was
 * wrong once dialect negotiation already filters legacy holders — a healthy
 * binary holder that was merely slow would never be asked again. Now a timeout
 * only opens a short cooldown (see `CWD_REFRESH_COOLDOWN_MS`).
 */
export async function refreshLiveCwd(id: string, timeoutMs = 250): Promise<boolean> {
  const link = instances.get(id)?.link;
  if (!link) return false;

  const plan = link.cwdRefresh.plan({
    hasLink: true,
    exited: link.exited,
    dialect: link.dialect,
    now: Date.now(),
  });
  if (plan === 'skip') return false;
  if (plan === 'join') return await link.cwdRefresh.wait();

  if (!sendHolderMessage(id, { type: 'cwdRequest' })) return false;

  const waited = link.cwdRefresh.wait();
  link.cwdRefreshTimer = setTimeout(() => {
    link.cwdRefreshTimer = null;
    link.cwdRefresh.onTimeout(Date.now());
  }, timeoutMs);
  return await waited;
}

export function sendHolderKill(id: string): boolean {
  return sendHolderMessage(id, { type: 'kill' });
}
