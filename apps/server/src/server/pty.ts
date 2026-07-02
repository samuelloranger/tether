import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import type { Socket } from 'bun';
import { addTerminalLog, deleteSession, getSession, upsertSession } from './db';

// Generate a bash rcfile that gives a fish-like prompt: cwd abbreviated to
// first letters (~/S/p/t/a/server), git branch, and a ❯ char. Written to a file
// (not an inlined PS1) so the shell logic stays readable.
const RC_DIR = path.join(process.cwd(), 'config');
const RC_PATH = path.join(RC_DIR, 'tether.bashrc');
const BASHRC = [
  '[ -f ~/.bashrc ] && source ~/.bashrc',
  '_tether_pwd() {',
  '  local tilde="~" p out="" seg i=0 n',
  '  p="${PWD/#$HOME/$tilde}"', // via var so ~ is not re-expanded back to $HOME
  '  local -a parts',
  '  IFS=/ read -ra parts <<< "$p"',
  '  n=${#parts[@]}',
  '  for seg in "${parts[@]}"; do',
  '    i=$((i+1))',
  '    if [ $i -lt $n ] && [ -n "$seg" ]; then',
  '      if [[ $seg == .* ]]; then out+="${seg:0:2}"; else out+="${seg:0:1}"; fi',
  '    else',
  '      out+="$seg"',
  '    fi',
  '    [ $i -lt $n ] && out+="/"',
  '  done',
  '  printf "%s" "$out"',
  '}',
  '_tether_branch() { local b; b=$(git branch --show-current 2>/dev/null); [ -n "$b" ] && printf " (%s)" "$b"; }',
  "PS1='\\[\\e[36m\\]$(_tether_pwd)\\[\\e[0m\\]\\[\\e[33m\\]$(_tether_branch)\\[\\e[0m\\] \\[\\e[32m\\]❯\\[\\e[0m\\] '",
  '',
].join('\n');
mkdirSync(RC_DIR, { recursive: true });
writeFileSync(RC_PATH, BASHRC);

// Each session's PTY lives in a detached holder process (holder.ts) so shells
// survive tether server restarts; we speak newline-delimited JSON to it over a
// unix socket (see holder.ts for the frame shapes). Holders live next to the
// DB so a TETHER_DB_PATH override (tests) gets its own isolated set.
const HOLDERS_DIR = process.env.TETHER_DB_PATH
  ? path.join(path.dirname(process.env.TETHER_DB_PATH), 'holders')
  : path.join(RC_DIR, 'holders');
const HOLDER_PATH = path.join(import.meta.dir, 'holder.ts');
mkdirSync(HOLDERS_DIR, { recursive: true });

const sockPathFor = (id: string) => path.join(HOLDERS_DIR, `${id}.sock`);

// If the daemon was (re)started from inside a Claude Code Bash tool, its env
// carries CLAUDE_CODE_CHILD_SESSION etc. Shells inheriting those make any
// `claude` run inside a tether terminal register as a hidden child session —
// invisible to /resume. Tether shells must look like fresh login shells.
export function scrubAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(out)) {
    if (k.startsWith('CLAUDE')) delete out[k];
  }
  return out;
}

interface SessionInstance {
  sock: Socket;
  subscribers: Set<
    (data: { type: 'output' | 'exit'; chunk?: string; exitCode?: number; id?: number }) => void
  >;
}

const instances = new Map<string, SessionInstance>();

// PTY dims from the network are untrusted: NaN/0/huge values wedge or crash the
// terminal. Clamp to a sane envelope.
export function clampDims(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = Math.floor(Number(cols));
  const r = Math.floor(Number(rows));
  return {
    cols: Number.isFinite(c) ? Math.min(500, Math.max(2, c)) : 80,
    rows: Number.isFinite(r) ? Math.min(200, Math.max(2, r)) : 24,
  };
}

function broadcast(
  id: string,
  data: { type: 'output' | 'exit'; chunk?: string; exitCode?: number; id?: number },
) {
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

// Connect to a session's holder socket and wire its frames into the existing
// log + broadcast pipeline. Resolves once attached; rejects if nothing listens.
function attach(id: string): Promise<SessionInstance> {
  // Per-session streaming decoder: buffers incomplete multi-byte UTF-8 sequences
  // across PTY read chunks so split emoji/wide glyphs don't decode to U+FFFD (�).
  const decoder = new TextDecoder('utf-8');
  let lineBuf = '';
  let exited = false;

  const handleLine = (line: string) => {
    let msg: { t: string; d?: string; code?: number };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.t === 'o' && msg.d) {
      const text = decoder.decode(Buffer.from(msg.d, 'base64'), { stream: true });
      if (!text) return;
      const logId = addTerminalLog(id, text);
      broadcast(id, { type: 'output', chunk: text, id: logId });
    } else if (msg.t === 'x') {
      exited = true;
      // Flush any buffered partial multi-byte sequence the streaming decoder is
      // still holding (PTY died mid-emoji) so the tail isn't silently dropped.
      const tail = decoder.decode();
      if (tail) {
        const logId = addTerminalLog(id, tail);
        broadcast(id, { type: 'output', chunk: tail, id: logId });
      }
      console.log(`PTY process for session "${id}" exited with code ${msg.code}`);
      const sess = getSession(id);
      upsertSession(id, sess?.command ?? 'bash', 'stopped');
      broadcast(id, { type: 'exit', exitCode: msg.code });
      instances.get(id)?.subscribers.clear();
      instances.delete(id);
    }
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    Bun.connect({
      unix: sockPathFor(id),
      socket: {
        open(sock) {
          settled = true;
          const instance: SessionInstance = { sock, subscribers: new Set() };
          instances.set(id, instance);
          resolve(instance);
        },
        data(_sock, buf) {
          lineBuf += buf.toString('utf8');
          let nl = lineBuf.indexOf('\n');
          while (nl !== -1) {
            const line = lineBuf.slice(0, nl);
            lineBuf = lineBuf.slice(nl + 1);
            nl = lineBuf.indexOf('\n');
            if (line) handleLine(line);
          }
        },
        close() {
          // Holder gone without an exit frame = it crashed or was killed hard.
          // Drop the instance so the next startSession spawns a fresh holder.
          if (!exited && instances.get(id)?.sock && instances.delete(id)) {
            console.log(`Holder link for session "${id}" closed unexpectedly`);
          }
        },
        error() {},
      },
    }).catch((err) => {
      if (!settled) reject(err);
    });
  });
}

function sendFrame(id: string, frame: object): boolean {
  const instance = instances.get(id);
  if (!instance) return false;
  try {
    instance.sock.write(`${JSON.stringify(frame)}\n`);
    return true;
  } catch {
    return false;
  }
}

// Concurrent startSession(id) calls (e.g. overlapping WS reconnects) must not
// each spawn their own holder: instances.set(id, ...) only happens once attach()
// actually connects, so a synchronous instances.get(id) check alone can't stop
// two racing callers from both missing it and both spawning a duplicate holder.
const pendingStarts = new Map<string, Promise<SessionInstance>>();

export function getDefaultShell(): string {
  try {
    const username = userInfo().username;
    const passwd = readFileSync('/etc/passwd', 'utf8');
    for (const line of passwd.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === username && parts[6]) {
        return parts[6];
      }
    }
  } catch {}
  return process.env.SHELL || 'bash';
}

export async function startSession(
  id: string,
  command: string = getDefaultShell(),
  cols: number = 80,
  rows: number = 24,
) {
  const existing = instances.get(id);
  if (existing) return existing;

  const pending = pendingStarts.get(id);
  if (pending) return pending;

  const promise = doStartSession(id, command, cols, rows).finally(() => {
    pendingStarts.delete(id);
  });
  pendingStarts.set(id, promise);
  return promise;
}

async function doStartSession(
  id: string,
  command: string,
  cols: number,
  rows: number,
): Promise<SessionInstance> {
  const dims = clampDims(cols, rows);
  upsertSession(id, command, 'running');

  // A holder may already be running from before a server restart — reattach.
  try {
    return await attach(id);
  } catch {}

  // No live holder: spawn one, detached so it outlives this server process.
  // For bash, load our rcfile for the fish-like prompt (still sources the user's
  // ~/.bashrc). Any other command runs as-is (e.g. the user's $SHELL, so fish
  // abbreviations etc. load from their own config).
  const isBash = path.basename(command) === 'bash';
  const args = isBash ? ['bash', '--rcfile', RC_PATH, '-i'] : [command, '-i'];
  const sockPath = sockPathFor(id);
  try {
    unlinkSync(sockPath); // stale socket from a dead holder
  } catch {}
  const logFd = openSync(path.join(HOLDERS_DIR, `${id}.log`), 'a');
  const holder = spawn(
    process.execPath,
    ['run', HOLDER_PATH, sockPath, String(dims.cols), String(dims.rows), homedir(), ...args],
    { detached: true, stdio: ['ignore', logFd, logFd], env: scrubAgentEnv(process.env) },
  );
  holder.unref();

  // Wait for the holder's socket to accept us (bun startup + listen).
  let lastErr: unknown;
  for (let i = 0; i < 25; i++) {
    await Bun.sleep(80);
    try {
      return await attach(id);
    } catch (err) {
      lastErr = err;
    }
  }
  upsertSession(id, command, 'stopped');
  throw new Error(`holder for session "${id}" never came up: ${lastErr}`);
}

// Reconnect to holders that survived a server restart. Returns the session ids
// that are still live so boot code can mark them running again.
export async function reattachHolders(): Promise<string[]> {
  const live: string[] = [];
  let socks: string[] = [];
  try {
    socks = readdirSync(HOLDERS_DIR).filter((f) => f.endsWith('.sock'));
  } catch {
    return live;
  }
  for (const f of socks) {
    const id = f.slice(0, -'.sock'.length);
    try {
      await attach(id);
      live.push(id);
    } catch {
      // Dead holder leftovers — clean up so they don't shadow future spawns.
      try {
        unlinkSync(path.join(HOLDERS_DIR, f));
      } catch {}
      try {
        unlinkSync(path.join(HOLDERS_DIR, `${f}.pid`));
      } catch {}
    }
  }
  return live;
}

export function writeToSession(id: string, text: string) {
  return sendFrame(id, { t: 'i', d: Buffer.from(text, 'utf8').toString('base64') });
}

export function resizeSession(id: string, cols: number, rows: number) {
  const dims = clampDims(cols, rows);
  return sendFrame(id, { t: 'r', c: dims.cols, r: dims.rows });
}

export function subscribeToSession(
  id: string,
  callback: (data: {
    type: 'output' | 'exit';
    chunk?: string;
    exitCode?: number;
    id?: number;
  }) => void,
) {
  const instance = instances.get(id);
  if (instance) {
    instance.subscribers.add(callback);
    return () => {
      instance.subscribers.delete(callback);
    };
  }
  return () => {};
}

export function killSession(id: string) {
  const instance = instances.get(id);
  const hadInstance = sendFrame(id, { t: 'k' });
  if (instance) instances.delete(id);
  // Fallback for holders we aren't attached to (or that ignore the frame).
  if (!hadInstance) {
    try {
      const pid = Number(readFileSync(`${sockPathFor(id)}.pid`, 'utf8'));
      if (pid > 0) process.kill(pid, 'SIGTERM');
    } catch {}
  }
  try {
    unlinkSync(path.join(HOLDERS_DIR, `${id}.log`));
  } catch {}
  // Fully remove the session (row + logs) so it disappears from the list — an
  // explicit kill means "gone", not "stopped but still shown".
  deleteSession(id);
  return hadInstance;
}

export function getActiveSession(id: string) {
  return instances.get(id);
}
