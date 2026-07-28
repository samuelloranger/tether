import { spawn } from 'node:child_process';
import { verifyPassword } from './auth';
import { setAuthHash } from './db';
import { selfArgv, VERSION } from './runtime';

const attempts = new Map<string, number[]>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

function allowed(client: string, now = Date.now()): boolean {
  const recent = (attempts.get(client) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) return false;
  recent.push(now);
  attempts.set(client, recent);
  return true;
}

export async function requireCurrentPassword(current: unknown, client: string): Promise<boolean> {
  if (!allowed(client) || typeof current !== 'string') return false;
  return verifyPassword(current);
}

export async function changePassword(
  current: unknown,
  next: unknown,
  client: string,
): Promise<boolean> {
  if (typeof next !== 'string' || !next || !(await requireCurrentPassword(current, client)))
    return false;
  setAuthHash(await Bun.password.hash(next, { algorithm: 'argon2id' }));
  return true;
}

// Run the same CLI control paths used locally. Delaying one tick lets the HTTP
// response leave the socket before `restart` stops this daemon.
export function scheduleAdminCommand(command: 'update' | 'restart'): void {
  setTimeout(() => {
    const [cmd, ...args] = selfArgv(command);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  }, 0);
}

export function updateTargetVersion(): string {
  return VERSION;
}

export function resetAdminRateLimit(): void {
  attempts.clear();
}
