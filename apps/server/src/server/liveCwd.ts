// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 7 is delimited by ESC/BEL control bytes by definition.
const OSC7_RE = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// Capture the authority as well as the path: for a drive-letter cwd it is empty
// or "localhost" and gets discarded, but for a UNC cwd it IS the server name
// (file://server/share ⇒ \\server\share), and dropping it loses half the path.
const FILE_URI_RE = /^file:\/\/([^/]*)(\/.*)$/;

// A file URI's path is always rooted at "/", so a drive-letter Windows cwd
// arrives as "/C:/Users/x" — the leading slash is URI syntax, not part of the
// path, and the separators are whatever the emitting shell used (our PowerShell
// profile writes forward slashes; cmd.exe's $P writes native backslashes). A
// UNC cwd instead carries the server in `authority` and arrives as
// authority="server", uriPath="/share/x" ⇒ \\server\share\x. Everything
// downstream — findGitRoot, the workspace file tree, upload paths — compares
// against values from node:path, so hand back the native form.
//
// Takes the platform explicitly rather than reading process.platform so the
// Windows shape stays testable from a POSIX CI runner.
export function normalizeOsc7Cwd(
  uriPath: string,
  authority = '',
  isWindows = process.platform === 'win32',
): string {
  if (!isWindows) return uriPath;
  // Drive letter wins over the authority. A local file URI routinely carries a
  // hostname there — file://HOST/C:/Users/x as well as the empty and localhost
  // forms — but the path is still a plain drive path, so the authority is not a
  // file server and must be dropped, not turned into \\HOST\C:\.
  const drive = /^\/([A-Za-z]:[\\/].*)$/.exec(uriPath);
  if (drive) return drive[1].replace(/\//g, '\\');
  // No drive letter but a real authority ⇒ UNC: the authority is the server and
  // uriPath is "/share/rest", so the native form is \\server\share\rest.
  if (authority && authority.toLowerCase() !== 'localhost') {
    return `\\\\${authority}${uriPath.replace(/\//g, '\\')}`;
  }
  return uriPath;
}

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
      const authority = fileMatch[1];
      try {
        cwd = normalizeOsc7Cwd(decodeURIComponent(fileMatch[2]), authority);
      } catch {
        cwd = normalizeOsc7Cwd(fileMatch[2], authority);
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

// Sets the live cwd directly from a known-good value (e.g. a kernel-level
// /proc read at holder attach time — see procCwd.ts) instead of waiting for
// the shell to draw a new OSC 7-carrying prompt, which may not happen for a
// long time (or ever, if the foreground job is a long-running TUI).
export function reportCwd(sessionId: string, cwd: string): void {
  stateBySession.set(sessionId, { cwd, residual: '', reported: true });
}

export function getLiveCwd(sessionId: string): string | null {
  return stateBySession.get(sessionId)?.cwd ?? null;
}

export function clearLiveCwd(sessionId: string): void {
  stateBySession.delete(sessionId);
}
