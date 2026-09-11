import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { genKeypair } from './noiseFfi';

// The server's long-term Noise static keypair — the identity every paired device
// pins. Generated once, never auto-rotated (rotating locks out every device).
// As sensitive as the TLS private key; stored owner-only.

function defaultDir(): string {
  const base = process.env.TETHER_DB_PATH
    ? path.dirname(process.env.TETHER_DB_PATH)
    : path.join(homedir(), '.tether', 'config');
  return path.join(base, 'noise');
}

export function loadOrCreateServerKeypair(dir: string = defaultDir()): {
  pub: Uint8Array;
  priv: Uint8Array;
} {
  const pubPath = path.join(dir, 'server.pub');
  const keyPath = path.join(dir, 'server.key');
  try {
    const pub = Uint8Array.from(Buffer.from(readFileSync(pubPath, 'utf8').trim(), 'base64'));
    const priv = Uint8Array.from(Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64'));
    if (pub.length === 32 && priv.length === 32) return { pub, priv };
  } catch {
    // fall through to generation
  }
  const { pub, priv } = genKeypair();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(pubPath, Buffer.from(pub).toString('base64'), { mode: 0o644 });
  writeFileSync(keyPath, Buffer.from(priv).toString('base64'), { mode: 0o600 });
  return { pub, priv };
}

export function serverFingerprint(pub: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(Buffer.from(pub)).digest('hex');
}
