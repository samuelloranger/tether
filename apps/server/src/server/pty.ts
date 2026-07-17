import { spawn } from 'node:child_process';
import {
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import type { Socket } from 'bun';
import { addTerminalLog, deleteSession, getSession, upsertSession } from './db';
import { type DiffSummary, EMPTY_DIFF_SUMMARY } from './gitDiff';
import { findGitRoot } from './gitRoot';
import { GitWatch } from './gitWatch';
import { clearLiveCwd, getLiveCwd, recordChunk } from './liveCwd';
import { CONFIG_DIR, OLD_HOLDERS_DIR, USING_DEFAULT_DB } from './paths';
import { COMPILED, selfArgv } from './runtime';

// Generate a bash rcfile that gives a fish-like prompt: cwd abbreviated to
// first letters (~/S/p/t/a/server), git branch, and a ❯ char. Written to a file
// (not an inlined PS1) so the shell logic stays readable.
// bashrc + holder sockets live alongside the DB (CONFIG_DIR already resolves
// env / installed-binary / dev-source to the right place — see paths.ts).
const RC_DIR = CONFIG_DIR;
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
  '_tether_osc7() { printf "\\e]7;file://%s%s\\a" "$(hostname)" "$PWD"; }',
  "PS1='\\[$(_tether_osc7)\\]\\[\\e[36m\\]$(_tether_pwd)\\[\\e[0m\\]\\[\\e[33m\\]$(_tether_branch)\\[\\e[0m\\] \\[\\e[32m\\]❯\\[\\e[0m\\] '",
  '',
].join('\n');
mkdirSync(RC_DIR, { recursive: true });
writeFileSync(RC_PATH, BASHRC);

// zsh has no --rcfile-equivalent flag for interactive mode; the standard,
// safe (zsh-only, unlike XDG_CONFIG_HOME) redirect is the ZDOTDIR env var,
// which zsh reads $ZDOTDIR/.zshrc from instead of ~/.zshrc. Only the invisible
// OSC 7 hook is added — no prompt replacement, since zsh users already have
// their own (bare `~/.zshrc`, not `$ZDOTDIR`-relative, so a customized
// ZDOTDIR of the user's own is intentionally not chased here — same
// simplification the bash rcfile already makes for ~/.bashrc).
const ZSH_RC_DIR = path.join(RC_DIR, 'zsh');
const ZSHRC = [
  '[ -f ~/.zshrc ] && source ~/.zshrc',
  '_tether_osc7() { printf "\\e]7;file://%s%s\\a" "$(hostname)" "$PWD"; }',
  'precmd_functions+=(_tether_osc7)',
  '',
].join('\n');
// ZDOTDIR redirects ALL of zsh's startup files, not just .zshrc — .zshenv is
// read even for non-interactive shells and is the canonical place users put
// PATH/SDK-manager/Nix env setup (zsh does not fall back to ~/.zshenv once
// ZDOTDIR is set, so without this that setup would silently vanish).
const ZSHENV = '[ -f ~/.zshenv ] && source ~/.zshenv\n';
mkdirSync(ZSH_RC_DIR, { recursive: true });
writeFileSync(path.join(ZSH_RC_DIR, '.zshrc'), ZSHRC);
writeFileSync(path.join(ZSH_RC_DIR, '.zshenv'), ZSHENV);

// fish has no rcfile-redirect env var without risking collateral effects on
// other XDG-aware tools in the session (XDG_CONFIG_HOME would redirect ALL of
// them, not just fish) — --init-command runs before fish's own config.fish,
// with no environment side effects at all.
const FISH_INIT =
  'function _tether_osc7 --on-event fish_prompt; printf "\\e]7;file://%s%s\\a" (hostname) (pwd); end';

// Each session's PTY lives in a detached holder process (holder.ts) so shells
// survive tether server restarts; we speak newline-delimited JSON to it over a
// unix socket (see holder.ts for the frame shapes). Holders live next to the
// bashrc in the same config dir.
const HOLDERS_DIR = path.join(RC_DIR, 'holders');
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

// The client-side emulator (terminal.ts) already renders 256-color and 24-bit
// truecolor SGR codes, but remote programs (vim, tmux, htop, less…) only emit
// them if TERM/COLORTERM advertise that support. Override rather than defer to
// whatever the tether server process happened to inherit (could be unset, or
// "dumb" in some launch contexts) — Tether shells always get the full palette.
export function withTermEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

// Every process running inside a session's shell — the agent, and anything it
// shells out to (e.g. `tether present`) — inherits this via normal fork/exec.
// It's how the server later links a preview back to the session that made it.
export function sessionEnv(
  id: string,
  env: NodeJS.ProcessEnv,
  shellEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  return { ...withTermEnv(scrubAgentEnv(env)), ...shellEnv, TETHER_SESSION_ID: id };
}

export type SessionFrame =
  | { type: 'output'; chunk: string; id: number }
  | { type: 'exit'; exitCode?: number }
  | { type: 'diff'; summary: DiffSummary };

export type Subscriber = (data: SessionFrame) => void;

interface SessionInstance {
  sock: Socket;
  subscribers: Set<Subscriber>;
  diffSummary: DiffSummary;
  gitWatch: GitWatch;
  // Each attached client's requested dims. A PTY has one size, so a shared session
  // is fit to the SMALLEST attached client (tmux model): content fits everyone and
  // a larger client just gets blank margin. Recomputed on attach/resize/detach.
  clientDims: Map<Subscriber, { cols: number; rows: number }>;
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

function broadcast(id: string, data: SessionFrame) {
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
function attach(id: string, sockPath: string = sockPathFor(id)): Promise<SessionInstance> {
  // Per-session streaming decoder: buffers incomplete multi-byte UTF-8 sequences
  // across PTY read chunks so split emoji/wide glyphs don't decode to U+FFFD (�).
  const decoder = new TextDecoder('utf-8');
  let lineBuf = '';
  let exited = false;

  // Frames from one socket `data()` read are batched into a single log row +
  // broadcast instead of one round-trip each — under bursty output (`cat` a big
  // file, `npm install`) a single read often carries many holder frames.
  let pendingOutput: string[] = [];
  const flushOutput = () => {
    if (pendingOutput.length === 0) return;
    const text = pendingOutput.join('');
    pendingOutput = [];
    const cwdReported = recordChunk(id, text);
    const cwd = getLiveCwd(id);
    if (cwdReported) instances.get(id)?.gitWatch.setRoot(cwd ? findGitRoot(cwd) : null);
    const logId = addTerminalLog(id, text);
    broadcast(id, { type: 'output', chunk: text, id: logId });
  };

  const handleLine = (line: string) => {
    let msg: { t: string; d?: string; code?: number };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.t === 'o' && msg.d) {
      const text = decoder.decode(Buffer.from(msg.d, 'base64'), { stream: true });
      if (text) pendingOutput.push(text);
    } else if (msg.t === 'x') {
      exited = true;
      // Flush any buffered partial multi-byte sequence the streaming decoder is
      // still holding (PTY died mid-emoji) so the tail isn't silently dropped.
      const tail = decoder.decode();
      if (tail) pendingOutput.push(tail);
      flushOutput();
      console.log(`PTY process for session "${id}" exited with code ${msg.code}`);
      const sess = getSession(id);
      upsertSession(id, sess?.command ?? 'bash', 'stopped');
      broadcast(id, { type: 'exit', exitCode: msg.code });
      instances.get(id)?.gitWatch.dispose();
      instances.get(id)?.subscribers.clear();
      instances.delete(id);
      clearLiveCwd(id);
    }
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    Bun.connect({
      unix: sockPath,
      socket: {
        open(sock) {
          settled = true;
          const gitWatch = new GitWatch((summary) => {
            const active = instances.get(id);
            if (!active) return;
            active.diffSummary = summary;
            broadcast(id, { type: 'diff', summary });
          });
          const instance: SessionInstance = {
            sock,
            subscribers: new Set(),
            diffSummary: EMPTY_DIFF_SUMMARY,
            gitWatch,
            clientDims: new Map(),
          };
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
          flushOutput();
        },
        close() {
          // Holder gone without an exit frame = it crashed or was killed hard.
          // Drop the instance so the next startSession spawns a fresh holder.
          const instance = instances.get(id);
          if (!exited && instance?.sock && instances.delete(id)) {
            instance.gitWatch.dispose();
            clearLiveCwd(id);
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

export interface ShellInvocation {
  args: string[];
  env?: Record<string, string>;
}

// Picks the spawn args (and any env override) that wire up shell integration
// (currently just OSC 7 cwd tracking) for the given command, per-shell since
// each needs a different injection mechanism — bash's --rcfile, zsh's ZDOTDIR
// redirect, fish's --init-command. Anything else runs as-is (matches the
// pre-existing fallback: no shell integration attempted).
export function shellInvocation(command: string): ShellInvocation {
  // Dispatch matches on basename, but argv[0] keeps the original (possibly
  // absolute, e.g. /opt/homebrew/bin/fish) command — the daemon's own PATH may
  // not include the shell's install directory even when the resolved login
  // shell (getDefaultShell(), read from /etc/passwd) does exist at that path.
  const shell = path.basename(command);
  if (shell === 'bash') return { args: [command, '--rcfile', RC_PATH, '-i'] };
  if (shell === 'zsh') return { args: [command, '-i'], env: { ZDOTDIR: ZSH_RC_DIR } };
  if (shell === 'fish') return { args: [command, '--init-command', FISH_INIT, '-i'] };
  return { args: [command, '-i'] };
}

async function doStartSession(
  id: string,
  command: string,
  cols: number,
  rows: number,
): Promise<SessionInstance> {
  const dims = clampDims(cols, rows);
  upsertSession(id, command, 'running', realpathSync(process.cwd()));

  // A holder may already be running from before a server restart — reattach.
  try {
    return await attach(id);
  } catch {}

  // No live holder: spawn one, detached so it outlives this server process.
  // shellInvocation wires up OSC 7 cwd tracking per-shell (bash/zsh/fish);
  // anything else runs as-is with no shell integration.
  const { args, env: shellEnv } = shellInvocation(command);
  const sockPath = sockPathFor(id);
  try {
    unlinkSync(sockPath); // stale socket from a dead holder
  } catch {}
  const logFd = openSync(path.join(HOLDERS_DIR, `${id}.log`), 'a');
  // Re-invoke ourselves with the `holder` subcommand so this works from source
  // (bun) and from the compiled binary alike (process.execPath is the binary).
  const [holderCmd, ...holderArgs] = selfArgv('holder', [
    sockPath,
    String(dims.cols),
    String(dims.rows),
    homedir(),
    ...args,
  ]);
  const holder = spawn(holderCmd, holderArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: sessionEnv(id, process.env, shellEnv),
  });
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

  const scan = async (dir: string, cleanupDead: boolean) => {
    let socks: string[] = [];
    try {
      socks = readdirSync(dir).filter((f) => f.endsWith('.sock'));
    } catch {
      return;
    }
    for (const f of socks) {
      const id = f.slice(0, -'.sock'.length);
      if (live.includes(id)) continue; // a holder in the primary dir already won
      const sockPath = path.join(dir, f);
      try {
        await attach(id, sockPath);
        live.push(id);
      } catch {
        // Dead holder leftovers — clean up so they don't shadow future spawns.
        // Only prune the primary dir; leave the old upgrade dir untouched.
        if (cleanupDead) {
          try {
            unlinkSync(sockPath);
          } catch {}
          try {
            unlinkSync(`${sockPath}.pid`);
          } catch {}
        }
      }
    }
  };

  await scan(HOLDERS_DIR, true);
  // One-time upgrade adoption: reattach live holders from a pre-binary install
  // (old server cwd) so in-flight sessions survive. Only for the installed binary
  // on its default path — never a dev run or TETHER_DB_PATH override — and it
  // self-disables once the old tree is gone.
  if (COMPILED && USING_DEFAULT_DB) await scan(OLD_HOLDERS_DIR, false);
  return live;
}

export function writeToSession(id: string, text: string) {
  return sendFrame(id, { t: 'i', d: Buffer.from(text, 'utf8').toString('base64') });
}

// Fit the PTY to the smallest attached client so a shared session renders
// consistently for everyone (no client's line-wrapping fights another's). No-op
// when no clients are attached (keeps the last size for reconnect replay).
function recomputeSize(id: string) {
  const inst = instances.get(id);
  if (!inst || inst.clientDims.size === 0) return;
  let cols = Number.POSITIVE_INFINITY;
  let rows = Number.POSITIVE_INFINITY;
  for (const d of inst.clientDims.values()) {
    cols = Math.min(cols, d.cols);
    rows = Math.min(rows, d.rows);
  }
  const dims = clampDims(cols, rows);
  sendFrame(id, { t: 'r', c: dims.cols, r: dims.rows });
}

// Record this client's requested size and re-fit the PTY to the smallest client.
export function resizeSession(id: string, client: Subscriber, cols: number, rows: number) {
  const inst = instances.get(id);
  if (!inst) return;
  inst.clientDims.set(client, clampDims(cols, rows));
  recomputeSize(id);
}

export function subscribeToSession(id: string, callback: Subscriber, cols: number, rows: number) {
  const instance = instances.get(id);
  if (instance) {
    instance.subscribers.add(callback);
    instance.clientDims.set(callback, clampDims(cols, rows));
    recomputeSize(id);
    callback({ type: 'diff', summary: instance.diffSummary });
    return () => {
      instance.subscribers.delete(callback);
      instance.clientDims.delete(callback);
      recomputeSize(id); // a client left → the PTY may grow back to the next-smallest
    };
  }
  return () => {};
}

export function killSession(id: string) {
  const instance = instances.get(id);
  const hadInstance = sendFrame(id, { t: 'k' });
  if (instance) {
    instance.gitWatch.dispose();
    instances.delete(id);
  }
  clearLiveCwd(id);
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
