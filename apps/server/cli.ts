#!/usr/bin/env bun
// Tether server control CLI. Install it on PATH (see `tether help`) and run
// `tether start` from anywhere to launch the backend as a detached background
// process. State lives in ~/.tether (pid + log). The server always runs with
// its own directory as cwd, so config/ and the SQLite db stay in apps/server/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const SERVER_DIR = import.meta.dir; // apps/server (resolved even via symlink)
const SERVER_ENTRY = path.join(SERVER_DIR, 'src', 'server', 'index.ts');
const STATE_DIR = path.join(homedir(), '.tether');
const PID_FILE = path.join(STATE_DIR, 'server.pid');
const LOG_FILE = path.join(STATE_DIR, 'server.log');
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
  // detached + own stdio + unref = survives this CLI process exiting.
  const child = spawn('bun', ['run', SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: process.env,
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
  help      Show this help

Env: TETHER_PORT (default 8085), TETHER_DB_PATH
State: ${STATE_DIR}`);
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
  default:
    help();
}
