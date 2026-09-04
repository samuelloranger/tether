import { acceptPairing, ChannelError, type FrameIO } from './noiseChannel';
import { derivePsk } from './noiseFfi';

// Crockford base32, excluding I L O U — must match the Rust core's alphabet.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 12;

export function generateCode(): string {
  const raw = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(raw);
  // 256 % 32 === 0, so a plain modulo is unbiased.
  let out = '';
  for (const b of raw) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function fingerprint(pubkeyBase64: string): string {
  return new Bun.CryptoHasher('sha256')
    .update(Buffer.from(pubkeyBase64, 'base64'))
    .digest('hex');
}

interface OpenWindow {
  code: string;
  psk: Uint8Array;
  expiresAt: number;
  attempts: number;
  consumed: boolean;
}

/**
 * A single-use, expiring enrollment window. `tether pair` opens one; a device
 * completes it with the printed code. Wrong-code/failed attempts are rate-capped.
 */
export class EnrollmentWindow {
  private win: OpenWindow | null = null;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; maxAttempts?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.now = opts.now ?? Date.now;
  }

  open(): { code: string; expiresAt: number } {
    const code = generateCode();
    const expiresAt = this.now() + this.ttlMs;
    this.win = { code, psk: derivePsk(code), expiresAt, attempts: 0, consumed: false };
    return { code, expiresAt };
  }

  isOpen(): boolean {
    const w = this.win;
    return (
      w !== null &&
      !w.consumed &&
      w.attempts < this.maxAttempts &&
      this.now() < w.expiresAt
    );
  }

  psk(): Uint8Array {
    if (!this.isOpen() || !this.win) throw new Error('no open enrollment window');
    return this.win.psk;
  }

  recordAttempt(): void {
    if (this.win) this.win.attempts += 1;
  }

  consume(): void {
    if (this.win) this.win.consumed = true;
  }

  close(): void {
    this.win = null;
  }
}

export class PairingError extends Error {
  constructor(public code: 'window_closed' | 'rejected' | 'handshake') {
    super(code);
    this.name = 'PairingError';
  }
}

export interface PairingDeps {
  addDevice: (input: { label: string; pubkey: string; address?: string }) => { pubkey: string };
  confirm: (proposal: { pubkeyBase64: string; fingerprint: string }) => boolean | Promise<boolean>;
  label: string;
  address?: string;
}

/**
 * Run one pairing over `io`: check the window is open, complete the XXpsk2
 * handshake, run host-confirm, enroll the device, and consume the window.
 */
export async function runPairing(
  io: FrameIO,
  serverPriv: Uint8Array,
  window: EnrollmentWindow,
  deps: PairingDeps,
): Promise<{ pubkey: string }> {
  if (!window.isOpen()) throw new PairingError('window_closed');
  const psk = window.psk();

  try {
    const { devicePubkey } = await acceptPairing(io, serverPriv, {
      psk,
      confirm: (p) =>
        deps.confirm({ pubkeyBase64: p.pubkeyBase64, fingerprint: fingerprint(p.pubkeyBase64) }),
    });
    deps.addDevice({ label: deps.label, pubkey: devicePubkey, address: deps.address });
    window.consume();
    return { pubkey: devicePubkey };
  } catch (err) {
    if (err instanceof ChannelError && err.code === 'rejected') {
      window.recordAttempt();
      throw new PairingError('rejected');
    }
    if (err instanceof ChannelError && err.code === 'handshake') {
      window.recordAttempt();
      throw new PairingError('handshake');
    }
    throw err;
  }
}
