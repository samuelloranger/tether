import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Socket } from 'bun';
import { getConfig } from './config';
import { addTerminalLog, clearInsertCount, deleteSession, getSession, upsertSession } from './db';
import { type DiffSummary, EMPTY_DIFF_SUMMARY } from './gitDiff';
import { findGitRoot } from './gitRoot';
import { EMPTY_REPO_STATUS, type RepoStatus } from './gitStatus';
import { GitWatch } from './gitWatch';
import { clearLiveCwd, getLiveCwd, recordChunk, reportCwd } from './liveCwd';
import type { NotificationEvent } from './notifications';
import { CONFIG_DIR } from './paths';
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
      console.error(`Error notifying subscriber for session "${id}":`, err);
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

type HolderLink = {
  decoder: TextDecoder;
  pendingOutput: string[];
  exited: boolean;
  lineBuf: string;
};

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

function handleHolderLine(id: string, line: string, link: HolderLink): void {
  let msg: { t: string; d?: string; code?: number };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.t === 'o' && msg.d) {
    const text = link.decoder.decode(Buffer.from(msg.d, 'base64'), { stream: true });
    if (text) link.pendingOutput.push(text);
  } else if (msg.t === 'c' && msg.d) {
    // A holder-reported cwd (spawn time, or a fresh kernel read on every new
    // client attach) — arms git watching without waiting on an OSC 7 prompt
    // redraw, which may be a long time coming (or never, mid-TUI).
    reportCwd(id, msg.d);
    instances.get(id)?.gitWatch.setRoot(findGitRoot(msg.d));
  } else if (msg.t === 'x') {
    link.exited = true;
    // Flush any buffered partial multi-byte sequence the streaming decoder is
    // still holding (PTY died mid-emoji) so the tail isn't silently dropped.
    const tail = link.decoder.decode();
    if (tail) link.pendingOutput.push(tail);
    flushHolderOutput(id, link);
    console.log(`PTY process for session "${id}" exited with code ${msg.code}`);
    if (killed.delete(id)) {
      deleteSession(id);
    } else {
      const sess = getSession(id);
      upsertSession(id, sess?.command ?? 'bash', 'stopped');
    }
    broadcast(id, { type: 'exit', exitCode: msg.code });
    notify(id, { type: 'exit', exitCode: msg.code });
    instances.get(id)?.gitWatch.dispose();
    instances.get(id)?.subscribers.clear();
    instances.delete(id);
    clearLiveCwd(id);
    clearTitle(id);
    clearInsertCount(id);
    clearActivity(id);
  }
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
      console.log(`Holder link for session "${id}" closed unexpectedly`);
    }
  }
}

// Connect to a session's holder socket and wire its frames into the existing
// log + broadcast pipeline. Resolves once attached; rejects if nothing listens.
export function attach(id: string, sockPath: string = sockPathFor(id)): Promise<SessionInstance> {
  const link: HolderLink = {
    decoder: new TextDecoder('utf-8'),
    pendingOutput: [],
    exited: false,
    lineBuf: '',
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    Bun.connect({
      unix: sockPath,
      socket: {
        open(sock) {
          settled = true;
          const gitWatch = new GitWatch((summary, status) => {
            const active = instances.get(id);
            if (!active) return;
            active.diffSummary = summary;
            active.repoStatus = status;
            broadcast(id, { type: 'diff', summary, status });
          });
          const instance: SessionInstance = {
            sock,
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
          link.lineBuf += buf.toString('utf8');
          let nl = link.lineBuf.indexOf('\n');
          while (nl !== -1) {
            const line = link.lineBuf.slice(0, nl);
            link.lineBuf = link.lineBuf.slice(nl + 1);
            nl = link.lineBuf.indexOf('\n');
            if (line) handleHolderLine(id, line, link);
          }
          flushHolderOutput(id, link);
        },
        close() {
          onHolderSocketClose(id, link);
        },
        error() {},
      },
    }).catch((err) => {
      if (!settled) reject(err);
    });
  });
}

export function sendFrame(id: string, frame: object): boolean {
  const instance = instances.get(id);
  if (!instance) return false;
  try {
    instance.sock.write(`${JSON.stringify(frame)}\n`);
    return true;
  } catch {
    return false;
  }
}
