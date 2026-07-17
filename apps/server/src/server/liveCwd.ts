// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 7 is delimited by ESC/BEL control bytes by definition.
const OSC7_RE = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const FILE_URI_RE = /^file:\/\/[^/]*(\/.*)$/;

export interface LiveCwdState {
  cwd: string | null;
  residual: string;
  reported: boolean;
}

export const INITIAL_LIVE_CWD_STATE: LiveCwdState = { cwd: null, residual: '', reported: false };

// Bounded so a chunk with no OSC 7 (or a stray unrelated escape) can't grow
// this without limit — an OSC 7 payload is a hostname + path, nowhere near
// this size.
const MAX_RESIDUAL = 4096;

// Scans one PTY output chunk for OSC 7 cwd reports — the same escape sequence
// terminal.ts's dispatchOsc (ps === '7' branch) parses client-side, mirrored
// here so the server trusts its own view of the shell's cwd instead of a
// value relayed back by the network client. `state.residual` carries a
// possibly incomplete escape sequence split across two chunks, the same
// streaming-boundary problem pty.ts's attach() already solves for UTF-8.
export function updateLiveCwd(state: LiveCwdState, chunk: string): LiveCwdState {
  const joined = state.residual + chunk;
  let cwd = state.cwd;
  let reported = false;
  let consumed = 0;
  OSC7_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
  while ((m = OSC7_RE.exec(joined))) {
    const fileMatch = FILE_URI_RE.exec(m[1]);
    if (fileMatch) {
      reported = true;
      try {
        cwd = decodeURIComponent(fileMatch[1]);
      } catch {
        cwd = fileMatch[1];
      }
    }
    consumed = OSC7_RE.lastIndex;
  }
  const tail = joined.slice(consumed);
  const oscStart = tail.lastIndexOf('\x1b]');
  if (oscStart === -1) return { cwd, residual: '', reported };
  const rest = tail.slice(oscStart);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: same ESC/BEL terminators as OSC7_RE above.
  const residual = /\x07|\x1b\\/.test(rest) ? '' : rest.slice(-MAX_RESIDUAL);
  return { cwd, residual, reported };
}

const stateBySession = new Map<string, LiveCwdState>();

export function recordChunk(sessionId: string, chunk: string): boolean {
  const prev = stateBySession.get(sessionId) ?? INITIAL_LIVE_CWD_STATE;
  const next = updateLiveCwd(prev, chunk);
  stateBySession.set(sessionId, next);
  return next.reported;
}

export function getLiveCwd(sessionId: string): string | null {
  return stateBySession.get(sessionId)?.cwd ?? null;
}

export function clearLiveCwd(sessionId: string): void {
  stateBySession.delete(sessionId);
}
