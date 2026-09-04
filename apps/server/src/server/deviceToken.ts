import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getDeviceById } from './deviceRegistry';

// Per-device REST auth tokens: a compact HMAC'd blob `{v,sub,iat,exp}` signed
// with a per-server secret. Stateless — revocation is "the device id is gone
// from the registry". Shape is `base64url(payload).base64url(hmac)`.

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SECRET_BYTES = 32;
const DEFAULT_TTL_SECONDS = 86400;

function defaultDir(): string {
  const base = process.env.TETHER_DB_PATH
    ? path.dirname(process.env.TETHER_DB_PATH)
    : path.join(homedir(), '.tether', 'config');
  return path.join(base, 'noise');
}

let cachedSecret: Buffer | null = null;

function loadOrCreateSecret(dir: string = defaultDir()): Buffer {
  if (cachedSecret) return cachedSecret;
  const secretPath = path.join(dir, 'auth.secret');
  try {
    const existing = readFileSync(secretPath);
    if (existing.length === SECRET_BYTES) {
      cachedSecret = existing;
      return cachedSecret;
    }
  } catch {
    // fall through to generation
  }
  const secret = randomBytes(SECRET_BYTES);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(secretPath, secret, { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  cachedSecret = secret;
  return cachedSecret;
}

function sign(payloadB64: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function mintToken(deviceId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const secret = loadOrCreateSecret();
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, sub: deviceId, iat, exp: iat + ttlSeconds }));
  const payloadB64 = payload.toString('base64url');
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export function looksLikeToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

export function verifyToken(
  token: string,
  opts?: { now?: number; deviceExists?: (id: string) => boolean },
): { deviceId: string } | null {
  if (!looksLikeToken(token)) return null;
  const [payloadB64, sigB64] = token.split('.');
  const secret = loadOrCreateSecret();
  const got = Buffer.from(sigB64, 'base64url');
  const want = createHmac('sha256', secret).update(payloadB64).digest();
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  let payload: { v?: unknown; sub?: unknown; iat?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as typeof payload;
  } catch {
    return null;
  }
  if (payload.v !== 1 || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
    return null;
  }
  const now = opts?.now ?? Date.now() / 1000;
  if (!(payload.exp > now)) return null;

  const deviceExists = opts?.deviceExists ?? ((id: string) => getDeviceById(id) !== null);
  if (!deviceExists(payload.sub)) return null;
  return { deviceId: payload.sub };
}
