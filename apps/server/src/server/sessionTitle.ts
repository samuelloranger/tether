// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 0/2 is delimited by ESC/BEL control bytes by definition.
const OSC_TITLE_RE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control bytes (tab kept) from title payloads.
const CONTROL_RE = /[\x00-\x08\x0a-\x1f\x7f]/g;

const MAX_TITLE = 128;
// Same bound as liveCwd's residual: an incomplete escape split across chunks
// is carried over, but a stray unterminated OSC can't grow it without limit.
const MAX_RESIDUAL = 4096;

export interface TitleState {
  title: string | null;
  residual: string;
  changed: boolean;
}

export const INITIAL_TITLE_STATE: TitleState = { title: null, residual: '', changed: false };

// Scans one PTY output chunk for OSC 0/2 title reports — the same sequences
// terminal.ts's dispatchOsc parses client-side, mirrored here so background
// sessions (no attached emulator) still get titles, and every client sees the
// same one. Streaming-boundary handling matches liveCwd.updateLiveCwd.
export function updateTitle(state: TitleState, chunk: string): TitleState {
  const joined = state.residual + chunk;
  let title = state.title;
  let consumed = 0;
  OSC_TITLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
  while ((m = OSC_TITLE_RE.exec(joined))) {
    const cleaned = m[1].replace(CONTROL_RE, '').trim().slice(0, MAX_TITLE);
    // An empty payload clears the title back to fallbacks — xterm semantics.
    title = cleaned || null;
    consumed = OSC_TITLE_RE.lastIndex;
  }
  const tail = joined.slice(consumed);
  const oscStart = tail.lastIndexOf('\x1b]');
  const changed = title !== state.title;
  if (oscStart === -1) return { title, residual: '', changed };
  const rest = tail.slice(oscStart);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: same ESC/BEL terminators as OSC_TITLE_RE above.
  const residual = /\x07|\x1b\\/.test(rest) ? '' : rest.slice(-MAX_RESIDUAL);
  return { title, residual, changed };
}

const stateBySession = new Map<string, TitleState>();

// Returns true when this chunk changed the session's title (set or cleared) —
// the caller uses that to broadcast a title frame only on real transitions.
export function recordTitleChunk(sessionId: string, chunk: string): boolean {
  const prev = stateBySession.get(sessionId) ?? INITIAL_TITLE_STATE;
  const next = updateTitle(prev, chunk);
  stateBySession.set(sessionId, next);
  return next.changed;
}

export function getOscTitle(sessionId: string): string | null {
  return stateBySession.get(sessionId)?.title ?? null;
}

export function clearTitle(sessionId: string): void {
  stateBySession.delete(sessionId);
}

// Display title when the user hasn't renamed the session: the app-set OSC
// title knows best; otherwise the directory name; the spawn command is the
// floor that always exists.
export function autoTitle(oscTitle: string | null, cwd: string | null, command: string): string {
  if (oscTitle) return oscTitle;
  if (cwd) {
    const base = cwd.split('/').filter(Boolean).pop();
    if (base) return base;
  }
  return command;
}
