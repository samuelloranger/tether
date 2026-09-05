import { spawn } from 'node:child_process';
import { openSync, readdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getConfig } from './config';
import { deleteSession, upsertSession } from './db';
import { clearLiveCwd } from './liveCwd';
import { OLD_HOLDERS_DIR, USING_DEFAULT_DB } from './paths';
import {
  attach,
  broadcast,
  type FocusSubscriber,
  HOLDERS_DIR,
  instances,
  killed,
  type SessionInstance,
  sendHolderInput,
  sendHolderKill,
  sendHolderResize,
  sockPathFor,
} from './ptyHolder';
import { clampDims, planPtyResize, shouldKickPtyOnFocus } from './ptyResize';
import { getDefaultShell, shellInvocation } from './ptyShell';
import { COMPILED, selfArgv } from './runtime';
import { clearActivity, recordInput } from './sessionActivity';
import { clearTitle } from './sessionTitle';
import { killWindowsTree } from './spawnWindow';

export type { FocusSubscriber, SessionFrame, Subscriber } from './ptyHolder';
export { sockPathFor } from './ptyHolder';
export { clampDims } from './ptyResize';
export { getDefaultShell, type ShellInvocation, shellInvocation } from './ptyShell';

const MAX_SESSIONS = Number(process.env.TETHER_MAX_SESSIONS || 50);

// How long to wait for a freshly spawned holder to start accepting on its
// socket. A `bun main.ts holder` is listening in well under a second, which is
// what the old fixed 25×80ms=2s budget was sized for. The compiled binary on
// Windows has to unpack and boot a ~90MB image — and be scanned on the way —
// which measures at 1.4-1.5s on a warm cache: inside the old budget, but only
// just, so session starts failed intermittently and left the tab 'stopped'.
// Generous rather than tuned: the loop exits as soon as the socket answers, so
// a high ceiling costs nothing on the happy path and only bounds the genuinely
// broken case.
const HOLDER_START_TIMEOUT_MS = Number(
  process.env.TETHER_HOLDER_START_TIMEOUT_MS || (process.platform === 'win32' ? 15_000 : 2_000),
);
const HOLDER_POLL_MS = 80;

// If the daemon was (re)started from inside a Claude Code Bash tool, its env
// carries CLAUDE_CODE_CHILD_SESSION etc. Shells inheriting those make any
// `claude` run inside a tether terminal register as a hidden child session —
// invisible to /resume. Tether shells must look like fresh login shells.
export function scrubAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(out)) {
    if (k.startsWith('CLAUDE')) delete out[k];
  }
  // A coding agent's own sandboxed Bash tool may set these to keep its tool
  // output parseable. If the daemon was (re)started from inside one, tether
  // shells would inherit color-disabling even though withTermEnv advertises
  // full color support.
  delete out.NO_COLOR;
  if (out.FORCE_COLOR === '0') delete out.FORCE_COLOR;
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

// Concurrent startSession(id) calls (e.g. overlapping WS reconnects) must not
// each spawn their own holder: instances.set(id, ...) only happens once attach()
// actually connects, so a synchronous instances.get(id) check alone can't stop
// two racing callers from both missing it and both spawning a duplicate holder.
const pendingStarts = new Map<string, Promise<SessionInstance>>();

export async function startSession(
  id: string,
  command?: string,
  cols: number = 80,
  rows: number = 24,
) {
  const existing = instances.get(id);
  if (existing) return existing;

  const pending = pendingStarts.get(id);
  if (pending) return pending;

  // Bound how many live holders one server will spawn — an authed client is
  // semi-trusted, but a runaway/buggy client shouldn't be able to fork
  // unlimited detached shell processes.
  if (instances.size >= MAX_SESSIONS) {
    throw new Error(`session cap reached (${MAX_SESSIONS})`);
  }

  const cfg = getConfig();
  const selectedCommand = command || cfg.session.defaultShell || getDefaultShell();
  const promise = doStartSession(id, selectedCommand, cols, rows).finally(() => {
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
  killed.delete(id); // a reused id is a new session, not the killed one
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
    getConfig().session.defaultCwd || homedir(),
    ...args,
  ]);
  const holder = spawn(holderCmd, holderArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: sessionEnv(id, process.env, shellEnv),
    // Without this the detached holder gets its own console window, which
    // flashes on screen for every session started on a desktop Windows host.
    windowsHide: true,
  });
  holder.unref();

  // Wait for the holder's socket to accept us (bun startup + listen).
  let lastErr: unknown;
  const deadline = Date.now() + HOLDER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(HOLDER_POLL_MS);
    try {
      const instance = await attach(id);
      // We spawned this holder ourselves, so its PTY size is known: record it so
      // the first client attaching at the same dims does not raise a pointless
      // SIGWINCH. (The reattach path above cannot know, and leaves it null.)
      instance.ptyDims = dims;
      return instance;
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
  // Keystrokes answer whatever the program was waiting on — flip the badge
  // immediately instead of waiting for echo output.
  const activity = recordInput(id);
  if (activity) broadcast(id, { type: 'activity', activity });
  return sendHolderInput(id, text);
}

// Fit the PTY to the smallest attached client so a shared session renders
// consistently for everyone (no client's line-wrapping fights another's). No-op
// when no clients are attached (keeps the last size for reconnect replay).
function recomputeSize(id: string) {
  const inst = instances.get(id);
  if (!inst) return;
  const dims = planPtyResize(inst.ptyDims, inst.clientDims.values());
  if (!dims) return;
  inst.ptyDims = dims;
  sendHolderResize(id, dims.cols, dims.rows);
}

// Record this client's requested size and re-fit the PTY to the smallest client.
export function resizeSession(id: string, client: FocusSubscriber, cols: number, rows: number) {
  const inst = instances.get(id);
  if (!inst) return;
  inst.clientDims.set(client, clampDims(cols, rows));
  recomputeSize(id);
}

export function subscribeToSession(
  id: string,
  callback: FocusSubscriber,
  cols: number,
  rows: number,
) {
  const instance = instances.get(id);
  if (instance) {
    instance.subscribers.add(callback);
    instance.clientDims.set(callback, clampDims(cols, rows));
    recomputeSize(id);
    callback({ type: 'diff', summary: instance.diffSummary, status: instance.repoStatus });
    return () => {
      instance.subscribers.delete(callback);
      instance.clientDims.delete(callback);
      recomputeSize(id); // a client left → the PTY may grow back to the next-smallest
    };
  }
  return () => {};
}

/** Re-send the current PTY size so the holder raises SIGWINCH even when the
 *  fit did not move. Ink/cursor-agent only redraw on SIGWINCH. */
function kickPtySize(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  const dims = inst.ptyDims ?? planPtyResize(null, inst.clientDims.values());
  if (!dims) return;
  sendHolderResize(id, dims.cols, dims.rows);
}

export function setSessionFocus(id: string, client: FocusSubscriber, focused: boolean): void {
  const instance = instances.get(id);
  if (!instance?.subscribers.has(client)) return;
  const was = client.focused;
  client.focused = focused;
  if (shouldKickPtyOnFocus({ wasFocused: was, sawFocus: client.sawFocus === true, focused })) {
    kickPtySize(id);
  }
  if (focused) client.sawFocus = true;
}

/** After HTTP git write ops, push a fresh diff summary without waiting on inotify. */
export function kickSessionGitWatch(id: string): void {
  instances.get(id)?.gitWatch.kick();
}

export function killSession(id: string) {
  const instance = instances.get(id);
  const hadInstance = sendHolderKill(id);
  // The holder's exit frame lands after we return; flag it so the 'x' handler
  // doesn't resurrect the row (see `killed`).
  if (hadInstance) killed.add(id);
  if (instance) {
    instance.gitWatch.dispose();
    // Tell subscribers now: we delete the instance below, so the holder's later
    // {t:'x'} frame would find no instance and never reach these clients.
    for (const sub of instance.subscribers) {
      try {
        sub({ type: 'exit' });
      } catch {}
    }
    instance.subscribers.clear();
    instances.delete(id);
  }
  clearLiveCwd(id);
  clearTitle(id);
  clearActivity(id);
  // Fallback for holders we aren't attached to (or that ignore the frame).
  if (!hadInstance) {
    try {
      const pid = Number(readFileSync(`${sockPathFor(id)}.pid`, 'utf8'));
      // On Windows a signal only ever terminates the one pid, so the holder's
      // shell (and everything under it) would survive this fallback. /T takes
      // the tree, matching what SIGTERM reaching the holder achieves on POSIX
      // by way of its own killHolderPty handler.
      if (pid > 0) {
        if (process.platform === 'win32') {
          killWindowsTree(pid);
        } else {
          process.kill(pid, 'SIGTERM');
        }
      }
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
