#!/usr/bin/env bun
// Tether server control CLI. Install it on PATH (see `tether help`) and run
// `tether start` from anywhere to launch the backend as a detached background
// process. State lives in ~/.tether (pid + log). The server always runs with
// its own directory as cwd, so config/ and the SQLite db stay in apps/server/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const SERVER_DIR = import.meta.dir; // apps/server (resolved even via symlink)
const SERVER_ENTRY = path.join(SERVER_DIR, 'src', 'server', 'index.ts');
const STATE_DIR = path.join(homedir(), '.tether');
const PID_FILE = path.join(STATE_DIR, 'server.pid');
const LOG_FILE = path.join(STATE_DIR, 'server.log');
const SRC_DIR = path.join(STATE_DIR, 'src'); // git cache clone for `tether update`
const REPO_URL = process.env.TETHER_REPO ?? 'https://github.com/samuelloranger/tether.git';
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
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  return pid && alive(pid) ? pid : null;
}

function start(): void {
  const existing = runningPid();
  if (existing) {
    console.log(`tether already running (pid ${existing}) on :${PORT}`);
    return;
  }
  const out = openSync(LOG_FILE, 'a');
  // Scrub Claude Code agent vars: a daemon (re)started from an agent's Bash
  // tool would otherwise leak CLAUDE_CODE_CHILD_SESSION into every tether
  // shell, making `claude` inside them a hidden child session (breaks /resume).
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE')) delete env[k];
  }
  // detached + own stdio + unref = survives this CLI process exiting.
  const child = spawn('bun', ['run', SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  if (child.pid) writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  console.log(`tether started (pid ${child.pid}) on :${PORT}`);
  console.log(`logs: ${LOG_FILE}`);
}

function stop(): void {
  const pid = runningPid();
  if (!pid) {
    console.log('tether not running');
    rmSync(PID_FILE, { force: true });
    return;
  }
  try {
    process.kill(pid);
  } catch {}
  rmSync(PID_FILE, { force: true });
  console.log(`tether stopped (pid ${pid})`);
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
  console.log(`tether: running (pid ${pid}) on :${PORT} — HTTP ${reachable ? 'ok' : 'not responding'}`);
}

function logs(): void {
  if (!existsSync(LOG_FILE)) {
    console.log('no logs yet');
    return;
  }
  // Stream the log (follow) like `tail -f`.
  spawn('tail', ['-n', '80', '-f', LOG_FILE], { stdio: 'inherit' });
}

function help(): void {
  console.log(`tether — backend server control

Usage: tether <command>

  start     Start the server in the background (:${PORT})
  stop      Stop the background server
  restart   Stop then start
  status    Show running state + HTTP health
  logs      Follow the server log (tail -f)
  set-password  Set the shared access password (required for clients)
  update    Pull the latest server code from GitHub and redeploy (keeps config/)
  help      Show this help

Env: TETHER_PORT (default 8085), TETHER_DB_PATH, TETHER_REPO
State: ${STATE_DIR}`);
}

// Read a line of hidden input. The old readline `_writeToOutput` mute emitted
// terminal refresh escapes (\x1b[0J) that wiped the visible prompt in a real
// terminal — the command looked frozen. This reads stdin directly instead:
// raw mode + manual char loop on a TTY (prompt stays visible, nothing echoes),
// plain line read when piped.
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
        if (c === '\x03') return finish(() => reject(new Error('cancelled'))); // Ctrl-C
        if (c === '\x7f' || c === '\b') {
          buf = buf.slice(0, -1); // backspace
        } else if (c >= ' ') {
          buf += c;
        }
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
  // db.ts derives its path from process.cwd(); this CLI runs from anywhere, so
  // point it at the server's own config dir (honoring an explicit TETHER_DB_PATH
  // override) — otherwise we'd write a stray db the running server never reads.
  process.env.TETHER_DB_PATH ||= path.join(SERVER_DIR, 'config', 'tether.db');
  const { setAuthHash } = await import('./src/server/db');
  const hash = await Bun.password.hash(password, { algorithm: 'argon2id' });
  setAuthHash(hash);
  console.log('Password set. Restart the server if it is running: tether restart');
}

// Run a child command inheriting stdio; exit the CLI on failure.
function run(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (r.error) {
    console.error(`\nCould not run ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} exited with code ${r.status}`);
    process.exit(1);
  }
}

// Pull the latest server code from GitHub and redeploy into ~/.tether/app,
// preserving config/ (the SQLite db + password). Restarts the daemon if it was
// running. Source repo overridable via TETHER_REPO.
function update(): void {
  const wasRunning = runningPid() !== null;

  if (existsSync(path.join(SRC_DIR, '.git'))) {
    console.log('Fetching latest tether source…');
    run('git', ['-C', SRC_DIR, 'fetch', '--depth', '1', 'origin', 'main']);
    run('git', ['-C', SRC_DIR, 'reset', '--hard', 'origin/main']);
  } else {
    console.log(`Cloning tether source from ${REPO_URL}…`);
    rmSync(SRC_DIR, { recursive: true, force: true });
    run('git', ['clone', '--depth', '1', REPO_URL, SRC_DIR]);
  }

  const serverSrc = `${path.join(SRC_DIR, 'apps', 'server')}/`;
  if (!existsSync(serverSrc)) {
    console.error(`\nUpdate failed: ${serverSrc} not found in the repo.`);
    process.exit(1);
  }

  console.log('Updating server files (preserving config/)…');
  // --delete drops files removed upstream; config/ + node_modules are preserved.
  run('rsync', [
    '-a',
    '--delete',
    '--exclude',
    'config/',
    '--exclude',
    'node_modules/',
    serverSrc,
    `${SERVER_DIR}/`,
  ]);

  console.log('Installing dependencies…');
  run('bun', ['install'], SERVER_DIR);

  if (wasRunning) {
    console.log('Restarting server…');
    stop();
    start();
  } else {
    console.log('Server not running. Start it with: tether start');
  }
  console.log('tether updated.');
}

const cmd = process.argv[2] ?? 'help';
switch (cmd) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    stop();
    start();
    break;
  case 'status':
    await status();
    break;
  case 'logs':
    logs();
    break;
  case 'set-password':
    await setPassword();
    break;
  case 'update':
    update();
    break;
  default:
    help();
}
