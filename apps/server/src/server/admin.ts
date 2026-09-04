import { spawn } from 'node:child_process';
import { selfArgv, VERSION } from './runtime';
import { HIDE_CONSOLE } from './spawnWindow';

const attempts = new Map<string, number[]>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

export function allowAdminRequest(client: string, now = Date.now()): boolean {
  const recent = (attempts.get(client) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) return false;
  recent.push(now);
  attempts.set(client, recent);
  return true;
}

// Run the same CLI control paths used locally. Delaying one tick lets the HTTP
// response leave the socket before `restart` stops this daemon.
export function scheduleAdminCommand(command: 'update' | 'restart'): void {
  setTimeout(() => {
    const [cmd, ...args] = selfArgv(command);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...HIDE_CONSOLE });
    child.unref();
  }, 0);
}

export function updateTargetVersion(): string {
  return VERSION;
}

export function resetAdminRateLimit(): void {
  attempts.clear();
}
