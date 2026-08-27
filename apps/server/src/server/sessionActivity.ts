import { getConfig } from './config';

// Per-session activity classification: is the foreground program busy
// (`working`), blocked on user input (`waiting`), or sitting at a shell prompt
// (`idle`)? Fed from the same PTY output chokepoint as liveCwd.ts and shaped
// the same way: a pure chunk scanner (streaming-safe across split escape
// sequences) plus a per-session in-memory store. Nothing here persists —
// state is advisory and rebuilds within seconds of output after a restart.

/**
 * `waiting` and `done` are deliberately separate. `waiting` means BLOCKED —
 * a program that cannot proceed without an answer, and the only state allowed
 * to pull attention away from whatever you are looking at. `done` means a piece
 * of work completed and the output is worth a look. `idle` is neither: a bare
 * shell prompt where nothing has happened at all.
 */
export type Activity = 'working' | 'waiting' | 'done' | 'idle';

/**
 * Where a `waiting` came from, which decides whether it may decay.
 *
 * `osc` is a guess — a bell or an OSC 9/777 notification, which agents send on
 * completion just as readily as on a question. `tail` is a guess with evidence:
 * the last visible line actually looks like a prompt. `signal` is not a guess
 * at all: the program said so through `/control/signal`.
 */
export type WaitingSource = 'signal' | 'osc' | 'tail';

// How long output must be silent before the tail-line heuristics run. Below
// this, a busy program that pauses between lines would flap.
export const SILENCE_MS = 15_000;

// Tail lines that look like a question/consent prompt — an interactive
// program waiting on the user. Checked before PROMPT_RE (a `?` beats a `>`).
const WAITING_RE =
  /(\(y\/n\)|\[y\/n\]|\[y\/N\]|\(yes\/no\)|do you want|proceed\?|continue\?|press enter|waiting for .{0,20}input|password[^:\n]*: ?$|\? ?$)/i;

// Tail lines that look like an ordinary shell prompt — nothing running.
const PROMPT_RE = /[$%#❯>] ?$/;

export interface ScanResult {
  // \x07 seen OUTSIDE an OSC string (OSC 7 cwd reports are BEL-terminated on
  // every prompt — those must not count as attention bells).
  bell: boolean;
  // OSC 9 / OSC 777;notify;… — an explicit program-sent notification.
  notify: { title?: string; body?: string } | null;
  // OSC 133 semantic prompt marks: A = prompt start, C = command executing.
  promptMark: string | null;
  // Last non-empty visible line (escapes stripped), for the silence heuristics.
  tail: string | null;
  // Unterminated trailing escape sequence, replayed before the next chunk.
  residual: string;
}

const MAX_RESIDUAL = 4096;
const MAX_TAIL = 200;

type ScanAcc = {
  bell: boolean;
  notify: ScanResult['notify'];
  promptMark: string | null;
  visible: string;
};

function unfinished(acc: ScanAcc, residual: string): ScanResult {
  return {
    bell: acc.bell,
    notify: acc.notify,
    promptMark: acc.promptMark,
    tail: lastLine(acc.visible),
    residual,
  };
}

// OSC: consume to BEL or ST (ESC \). Unterminated → residual.
function consumeOsc(text: string, i: number, acc: ScanAcc): number | ScanResult {
  let end = i + 2;
  let term = 0;
  while (end < text.length) {
    if (text[end] === '\x07') {
      term = 1;
      break;
    }
    if (text[end] === '\x1b' && text[end + 1] === '\\') {
      term = 2;
      break;
    }
    end++;
  }
  if (end >= text.length) return unfinished(acc, text.slice(i).slice(-MAX_RESIDUAL));
  const payload = text.slice(i + 2, end);
  if (payload.startsWith('9;')) {
    acc.notify = { body: payload.slice(2) };
  } else if (payload.startsWith('777;notify;')) {
    const [, , title = '', ...body] = payload.split(';');
    acc.notify = { title, body: body.join(';') };
  } else if (payload.startsWith('133;')) acc.promptMark = payload.slice(4, 5) || null;
  return end + term;
}

// CSI (to final byte @-~) or DCS/APC/PM (to ST).
function consumeCsiOrString(
  text: string,
  i: number,
  next: string,
  acc: ScanAcc,
): number | ScanResult {
  let end = i + 2;
  if (next === '[') {
    while (end < text.length && !(text[end] >= '@' && text[end] <= '~')) end++;
    if (end >= text.length) return unfinished(acc, text.slice(i).slice(-MAX_RESIDUAL));
    return end + 1;
  }
  while (end < text.length && !(text[end] === '\x1b' && text[end + 1] === '\\')) end++;
  if (end >= text.length) return unfinished(acc, text.slice(i).slice(-MAX_RESIDUAL));
  return end + 2;
}

// Scan one PTY output chunk. Walks the text so escape-sequence interiors
// (OSC payloads, CSI params) never leak into bell detection or the visible
// tail. `residual` carries an escape sequence split across chunk boundaries.
export function scanChunk(residual: string, chunk: string): ScanResult {
  const text = residual + chunk;
  const acc: ScanAcc = { bell: false, notify: null, promptMark: null, visible: '' };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\x07') {
      acc.bell = true;
      i++;
      continue;
    }
    if (ch !== '\x1b') {
      acc.visible += ch;
      i++;
      continue;
    }
    const next = text[i + 1];
    if (next === ']') {
      const step = consumeOsc(text, i, acc);
      if (typeof step !== 'number') return step;
      i = step;
      continue;
    }
    if (next === '[' || next === 'P' || next === '_' || next === '^') {
      const step = consumeCsiOrString(text, i, next, acc);
      if (typeof step !== 'number') return step;
      i = step;
      continue;
    }
    // Two-char escape (ESC + one byte) or bare trailing ESC.
    if (next === undefined) return unfinished(acc, '\x1b');
    i += 2;
  }
  return unfinished(acc, '');
}

function lastLine(visible: string): string | null {
  // \r moves the cursor to column 0 — treat like a line break for tail purposes.
  const lines = visible.split(/[\r\n]/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line.slice(-MAX_TAIL);
  }
  return null;
}

interface SessionActivityState {
  activity: Activity;
  since: number;
  lastOutputAt: number;
  tail: string;
  residual: string;
  waitingSource: WaitingSource | null;
  agentDriven: boolean;
}

const stateBySession = new Map<string, SessionActivityState>();

function getState(id: string, now: number): SessionActivityState {
  let st = stateBySession.get(id);
  if (!st) {
    st = {
      activity: 'working',
      since: now,
      lastOutputAt: now,
      tail: '',
      residual: '',
      waitingSource: null,
      agentDriven: false,
    };
    stateBySession.set(id, st);
  }
  return st;
}

function transition(
  st: SessionActivityState,
  next: Activity,
  now: number,
  source: WaitingSource | null = null,
): Activity | null {
  if (st.activity === next) return null;
  st.activity = next;
  st.since = now;
  st.waitingSource = next === 'waiting' ? source : null;
  return next;
}

// Feed one output chunk. Returns the new activity when it changed, else null
// (callers broadcast transitions to attached clients).
export function recordOutput(id: string, chunk: string, now = Date.now()): Activity | null {
  return recordOutputEvent(id, chunk, now).activity;
}

export interface ActivityOutputEvent {
  activity: Activity | null;
  notify: ScanResult['notify'];
  longJob: boolean;
}

// Extended output result for server-side alerting. The compatibility wrapper
// above keeps the client activity protocol and existing callers unchanged.
export function recordOutputEvent(
  id: string,
  chunk: string,
  now = Date.now(),
): ActivityOutputEvent {
  const fresh = !stateBySession.has(id);
  const st = getState(id, now);
  const previousActivity = st.activity;
  const previousSince = st.since;
  const scan = scanChunk(st.residual, chunk);
  st.residual = scan.residual;
  st.lastOutputAt = now;
  if (scan.tail) st.tail = scan.tail;
  // Strongest signal wins; explicit attention beats prompt marks beats plain output.
  let activity: Activity | null;
  if ((scan.bell || scan.notify) && !st.agentDriven)
    activity = transition(st, 'waiting', now, 'osc');
  else if (scan.promptMark === 'A') activity = releaseToIdle(st, now);
  else if (scan.promptMark === 'C') activity = transition(st, 'working', now);
  else if (scan.tail === null)
    activity = fresh ? st.activity : null; // pure escape chunk — no evidence
  // Plain visible output = the program is doing something — UNLESS the session
  // speaks for itself. A full-screen agent redraws its interface constantly,
  // including once more right after its own "I finished" signal, so treating
  // that redraw as work undoes the signal a few milliseconds after it lands and
  // the session never looks finished for longer than one frame. An agent-driven
  // session goes back to `working` when it says so (its prompt-submit hook), or
  // when a shell prompt releases the latch.
  else if (st.agentDriven) activity = null;
  // A fresh session reports its first classification even without a change, so
  // clients get an initial frame.
  else activity = transition(st, 'working', now) ?? (fresh ? st.activity : null);
  return {
    // An agent that signals has a better channel than its own OSC stream, and
    // ptyHolder turns any notify payload into a push. Passing it through would
    // deliver the completion alarm this change exists to remove, alongside the
    // signal's own (default-silent) one.
    notify: st.agentDriven ? null : scan.notify,
    activity,
    longJob:
      previousActivity === 'working' &&
      (activity === 'idle' || activity === 'waiting') &&
      now - previousSince >= getConfig().longJobSeconds * 1000,
  };
}

// User keystrokes answer whatever the program was waiting on.
export function recordInput(id: string, now = Date.now()): Activity | null {
  const st = stateBySession.get(id);
  if (!st) return null;
  // A keystroke answers a `waiting`, and it also ends a `done`: you are typing
  // the next thing, so the last thing is over. That second case is what keeps a
  // two-hook config working — an agent-driven session ignores its own output,
  // so without this nothing would leave `done` until the agent signalled again,
  // and anyone who pasted the Notification/Stop pair before `UserPromptSubmit`
  // existed would watch a whole turn run while the tab claimed to be finished.
  if (st.activity !== 'waiting' && st.activity !== 'done') return null;
  return transition(st, 'working', now);
}

/**
 * The states a program may claim for itself. `idle` is missing on purpose: it
 * describes a shell prompt, which is the server's observation to make, not the
 * program's claim — and it is the observation that releases the latch.
 */
export type SignalState = 'working' | 'waiting' | 'done';

/**
 * A program declaring its own state, through `/control/signal`.
 *
 * This latches the session as agent-driven, and from then on the byte
 * heuristics stop guessing for it. Mixing the two sources produces flapping:
 * Claude Code emits the same OSC 777 when it finishes as when it asks, so the
 * scanner would immediately re-classify a signalled `done` as `waiting`, which
 * is exactly the confusion the signal exists to remove. The latch is released
 * when the session reaches a shell prompt — see `releaseToIdle`.
 */
export function recordSignal(id: string, state: SignalState, now = Date.now()): Activity | null {
  const st = getState(id, now);
  st.agentDriven = true;
  return transition(st, state, now, state === 'waiting' ? 'signal' : null);
}

/** Whether this session is currently speaking for itself. */
export function isAgentDriven(id: string): boolean {
  return stateBySession.get(id)?.agentDriven ?? false;
}

// Read the current classification. Applies the silence heuristics lazily —
// the 4s client poll of /api/sessions is the clock, so no server-side timer.
//
// This mutates on read, and its ONLY caller is the session-list route, so a
// decay is never broadcast over the WebSocket: an attached client learns of it
// on its next poll, up to 4s later. That is deliberate — the alternative is a
// timer per session for a change nobody is waiting on.
export function getActivity(id: string, now = Date.now()): Activity | null {
  const st = stateBySession.get(id);
  if (!st) return null;
  if (now - st.lastOutputAt < getConfig().session.silenceMs) return st.activity;
  if (st.activity === 'working') {
    // An agent speaks for itself, so its silence is not evidence of a question.
    if (!st.agentDriven && WAITING_RE.test(st.tail)) transition(st, 'waiting', now, 'tail');
    else if (PROMPT_RE.test(st.tail)) releaseToIdle(st, now);
  } else if (st.activity === 'waiting' && st.waitingSource === 'osc') {
    // A bell or an OSC notification is not evidence of a question — agents fire
    // the same sequence when they finish. If the screen is not actually asking
    // anything after the silence window, this was a completion, and leaving it
    // lit as an alarm is the bug this whole change exists to fix.
    if (!WAITING_RE.test(st.tail)) transition(st, 'done', now);
  } else if (PROMPT_RE.test(st.tail)) {
    // `done`, or a `waiting` the OSC decay above did not claim — including one
    // a program declared. An agent killed while it was blocked leaves its shell
    // sitting at a prompt: without this the tab stays urgent forever and, being
    // still latched, swallows every later notification.
    releaseToIdle(st, now);
  }
  return st.activity;
}

/**
 * A shell prompt — the tail regex, or an OSC 133;A semantic mark — is the one
 * unambiguous signal that whatever was running has exited, including the agent.
 * So this is also where the agent-driven latch is released: without it, quitting Claude Code would leave the session
 * permanently exempt from the heuristics, stuck on whatever state it died in.
 */
function releaseToIdle(st: SessionActivityState, now: number): Activity | null {
  st.agentDriven = false;
  return transition(st, 'idle', now);
}

export function clearActivity(id: string): void {
  stateBySession.delete(id);
}
