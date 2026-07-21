#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { LOG_FILE, PID_FILE, PRESENT_CONTROL_TOKEN_FILE, STATE_DIR } from './paths';
import { processStartTime } from './procIdentity';
import { COMPILED, selfArgv, VERSION } from './runtime';

const PORT = process.env.TETHER_PORT ?? '8085';

mkdirSync(STATE_DIR, { recursive: true });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const [pidStr, token = ''] = readFileSync(PID_FILE, 'utf8').trim().split(' ');
  const pid = Number(pidStr);
  if (!pid || !alive(pid)) return null;
  // A recycled PID won't have the start time we recorded — treat it as dead so
  // stop()/status() never signal an unrelated process that reused the number.
  if (token && processStartTime(pid) !== token) return null;
  return pid;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll until the pid is gone or timeoutMs elapses. Used so stop()/start() never
// hand off to each other while the old process still holds the port.
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const step = 100;
  for (let waited = 0; waited < timeoutMs; waited += step) {
    if (!alive(pid)) return true;
    await sleep(step);
  }
  return !alive(pid);
}

async function start(): Promise<void> {
  const existing = runningPid();
  if (existing) {
    console.log(`tether already running (pid ${existing}) on :${PORT}`);
    return;
  }
  // Atomically claim the pid file so two concurrent `start`s can't both spawn a
  // daemon (the loser would otherwise die on EADDRINUSE after already forking).
  let lockFd: number;
  try {
    lockFd = openSync(PID_FILE, 'wx');
  } catch {
    if (runningPid()) {
      console.log('tether already running');
      return;
    }
    // Stale/empty pid file from a crashed start — clear it and claim once more.
    rmSync(PID_FILE, { force: true });
    try {
      lockFd = openSync(PID_FILE, 'wx');
    } catch {
      console.log('tether is already starting');
      return;
    }
  }
  const out = openSync(LOG_FILE, 'a');
  // Scrub Claude Code agent vars so a daemon (re)started from an agent's shell
  // doesn't leak CLAUDE_CODE_CHILD_SESSION into every tether PTY (breaks /resume).
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE')) delete env[k];
  }
  const [cmd, ...args] = selfArgv('serve');
  const child = spawn(cmd, args, {
    cwd: homedir(),
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  if (!child.pid) {
    console.error('tether failed to start: spawn returned no pid');
    closeSync(lockFd);
    rmSync(PID_FILE, { force: true });
    process.exitCode = 1;
    return;
  }
  // spawn() succeeding only means the OS forked/exec'd; the child can still die
  // in the first few hundred ms (e.g. EADDRINUSE if the old process hadn't
  // released the port yet). Confirm it's still alive before trusting it.
  await sleep(500);
  if (!alive(child.pid)) {
    console.error(`tether failed to start — check logs: ${LOG_FILE}`);
    closeSync(lockFd);
    rmSync(PID_FILE, { force: true });
    process.exitCode = 1;
    return;
  }
  const token = processStartTime(child.pid) ?? '';
  writeFileSync(PID_FILE, `${child.pid} ${token}`);
  closeSync(lockFd);
  console.log(`tether started (pid ${child.pid}) on :${PORT}`);
  console.log(`logs: ${LOG_FILE}`);
}

async function stop(): Promise<void> {
  const pid = runningPid();
  if (!pid) {
    console.log('tether not running');
    rmSync(PID_FILE, { force: true });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  let exited = await waitForExit(pid, 3000);
  if (!exited) {
    console.log(`tether (pid ${pid}) didn't exit after SIGTERM, sending SIGKILL…`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    exited = await waitForExit(pid, 2000);
  }
  rmSync(PID_FILE, { force: true });
  if (exited) {
    console.log(`tether stopped (pid ${pid})`);
  } else {
    console.error(`tether (pid ${pid}) still alive after SIGKILL — giving up`);
    process.exitCode = 1;
  }
}

async function status(): Promise<void> {
  const pid = runningPid();
  if (!pid) {
    console.log('tether: stopped');
    return;
  }
  let reachable = false;
  try {
    const res = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) });
    reachable = res.ok;
  } catch {}
  console.log(
    `tether: running (pid ${pid}) on :${PORT} — HTTP ${reachable ? 'ok' : 'not responding'}`,
  );
}

function logs(): void {
  if (!existsSync(LOG_FILE)) {
    console.log('no logs yet');
    return;
  }
  spawn('tail', ['-n', '80', '-f', LOG_FILE], { stdio: 'inherit' });
}

// Read a line of hidden input: raw-mode manual char loop on a TTY (prompt stays
// visible, nothing echoes), plain line read when piped.
function readHidden(promptText: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(promptText);
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.resume();
      const onData = (d: string) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          stdin.off('data', onData);
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ''));
        }
      };
      stdin.on('data', onData);
    });
  }
  return new Promise((resolve, reject) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      fn();
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return finish(() => resolve(buf));
        if (c === '\x03') return finish(() => reject(new Error('cancelled')));
        if (c === '\x7f' || c === '\b') buf = buf.slice(0, -1);
        else if (c >= ' ') buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function setPassword(): Promise<void> {
  let password: string;
  try {
    password = await readHidden('New Tether password: ');
  } catch {
    console.error('\nCancelled.');
    process.exit(1);
  }
  if (!password || password.length < 1) {
    console.error('Password cannot be empty.');
    process.exit(1);
  }
  const { setAuthHash } = await import('./db');
  setAuthHash(await Bun.password.hash(password, { algorithm: 'argon2id' }));
  console.log('Password set. Restart the server if it is running: tether restart');
}

function help(): void {
  console.log(`tether — persistent remote-shell server (v${VERSION})

Usage: tether <command>

  (none) / serve   Run the server in the foreground
  start            Start the server in the background (:${PORT})
  stop             Stop the background server
  restart          Stop then start
  status           Show running state + HTTP health
  logs             Follow the server log (tail -f)
  present          Open/reset an agent HTML preview or install an agent skill
  set-password     Set the shared access password (required for clients)
  update           Download the latest release binary and restart
  version          Print the version
  help             Show this help

Env: TETHER_PORT (default 8085), TETHER_DB_PATH, TETHER_REPO_SLUG
State: ${STATE_DIR}`);
}

const cmd = process.argv[2] ?? 'serve';
switch (cmd) {
  case 'serve': {
    // Lazy so control commands (stop/status/version/update) don't pull in
    // serve→db and open/migrate the SQLite DB just to read a pid or print help.
    const { serve } = await import('./serve');
    await serve();
    break;
  }
  case 'start':
    await start();
    break;
  case 'stop':
    await stop();
    break;
  case 'restart':
    await stop();
    await start();
    break;
  case 'status':
    await status();
    break;
  case 'logs':
    logs();
    break;
  case 'present': {
    const { parsePresentArgs, runPresent } = await import('./presentCli');
    try {
      await runPresent(parsePresentArgs(process.argv.slice(3)), {
        port: PORT,
        tokenFile: PRESENT_CONTROL_TOKEN_FILE,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    break;
  }
  case 'set-password':
    await setPassword();
    break;
  case 'update': {
    const { runUpdate } = await import('./update');
    await runUpdate({ version: VERSION, compiled: COMPILED, start, stop, runningPid });
    break;
  }
  case 'holder': {
    // Internal: the PTY holder process, spawned by pty.ts via selfArgv('holder').
    const { runHolder } = await import('./holder');
    runHolder(process.argv.slice(3));
    break;
  }
  case 'version':
    console.log(VERSION);
    break;
  default:
    help();
}
