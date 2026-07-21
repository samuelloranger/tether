// Per-session activity classification: is the foreground program busy
// (`working`), blocked on user input (`waiting`), or sitting at a shell prompt
// (`idle`)? Fed from the same PTY output chokepoint as liveCwd.ts and shaped
// the same way: a pure chunk scanner (streaming-safe across split escape
// sequences) plus a per-session in-memory store. Nothing here persists —
// state is advisory and rebuilds within seconds of output after a restart.

export type Activity = 'working' | 'waiting' | 'idle';

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
  notify: boolean;
  // OSC 133 semantic prompt marks: A = prompt start, C = command executing.
  promptMark: string | null;
  // Last non-empty visible line (escapes stripped), for the silence heuristics.
  tail: string | null;
  // Unterminated trailing escape sequence, replayed before the next chunk.
  residual: string;
}

const MAX_RESIDUAL = 4096;
const MAX_TAIL = 200;

// Scan one PTY output chunk. Walks the text so escape-sequence interiors
// (OSC payloads, CSI params) never leak into bell detection or the visible
// tail. `residual` carries an escape sequence split across chunk boundaries.
export function scanChunk(residual: string, chunk: string): ScanResult {
  const text = residual + chunk;
  let bell = false;
  let notify = false;
  let promptMark: string | null = null;
  let visible = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\x07') {
      bell = true;
      i++;
      continue;
    }
    if (ch !== '\x1b') {
      visible += ch;
      i++;
      continue;
    }
    const next = text[i + 1];
    if (next === ']') {
      // OSC: consume to BEL or ST (ESC \). Unterminated → residual.
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
      if (end >= text.length) {
        return {
          bell,
          notify,
          promptMark,
          tail: lastLine(visible),
          residual: text.slice(i).slice(-MAX_RESIDUAL),
        };
      }
      const payload = text.slice(i + 2, end);
      if (payload.startsWith('9;') || payload.startsWith('777;notify')) notify = true;
      else if (payload.startsWith('133;')) promptMark = payload.slice(4, 5) || null;
      i = end + term;
      continue;
    }
    if (next === '[' || next === 'P' || next === '_' || next === '^') {
      // CSI (to final byte @-~) or DCS/APC/PM (to ST).
      let end = i + 2;
      if (next === '[') {
        while (end < text.length && !(text[end] >= '@' && text[end] <= '~')) end++;
        if (end >= text.length) {
          return {
            bell,
            notify,
            promptMark,
            tail: lastLine(visible),
            residual: text.slice(i).slice(-MAX_RESIDUAL),
          };
        }
        i = end + 1;
      } else {
        while (end < text.length && !(text[end] === '\x1b' && text[end + 1] === '\\')) end++;
        if (end >= text.length) {
          return {
            bell,
            notify,
            promptMark,
            tail: lastLine(visible),
            residual: text.slice(i).slice(-MAX_RESIDUAL),
          };
        }
        i = end + 2;
      }
      continue;
    }
    // Two-char escape (ESC + one byte) or bare trailing ESC.
    if (next === undefined) {
      return { bell, notify, promptMark, tail: lastLine(visible), residual: '\x1b' };
    }
    i += 2;
  }
  return { bell, notify, promptMark, tail: lastLine(visible), residual: '' };
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
}

const stateBySession = new Map<string, SessionActivityState>();

function getState(id: string, now: number): SessionActivityState {
  let st = stateBySession.get(id);
  if (!st) {
    st = { activity: 'working', since: now, lastOutputAt: now, tail: '', residual: '' };
    stateBySession.set(id, st);
  }
  return st;
}

function transition(st: SessionActivityState, next: Activity, now: number): Activity | null {
  if (st.activity === next) return null;
  st.activity = next;
  st.since = now;
  return next;
}

// Feed one output chunk. Returns the new activity when it changed, else null
// (callers broadcast transitions to attached clients).
export function recordOutput(id: string, chunk: string, now = Date.now()): Activity | null {
  const fresh = !stateBySession.has(id);
  const st = getState(id, now);
  const scan = scanChunk(st.residual, chunk);
  st.residual = scan.residual;
  st.lastOutputAt = now;
  if (scan.tail) st.tail = scan.tail;
  // Strongest signal wins; explicit attention beats prompt marks beats plain output.
  if (scan.bell || scan.notify) return transition(st, 'waiting', now);
  if (scan.promptMark === 'A') return transition(st, 'idle', now);
  if (scan.promptMark === 'C') return transition(st, 'working', now);
  if (scan.tail === null) return fresh ? st.activity : null; // pure escape chunk — no evidence
  // Plain visible output = the program is doing something. A fresh session
  // reports its first classification even without a change, so clients get an
  // initial frame.
  return transition(st, 'working', now) ?? (fresh ? st.activity : null);
}

// User keystrokes answer whatever the program was waiting on.
export function recordInput(id: string, now = Date.now()): Activity | null {
  const st = stateBySession.get(id);
  if (!st) return null;
  if (st.activity !== 'waiting') return null;
  return transition(st, 'working', now);
}

// Read the current classification. Applies the silence heuristics lazily —
// the 4s client poll of /api/sessions is the clock, so no server-side timer.
export function getActivity(id: string, now = Date.now()): Activity | null {
  const st = stateBySession.get(id);
  if (!st) return null;
  if (st.activity === 'working' && now - st.lastOutputAt >= SILENCE_MS) {
    if (WAITING_RE.test(st.tail)) return 'waiting';
    if (PROMPT_RE.test(st.tail)) return 'idle';
  }
  return st.activity;
}

export function clearActivity(id: string): void {
  stateBySession.delete(id);
}
