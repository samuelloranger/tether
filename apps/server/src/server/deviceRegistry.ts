import { db } from './db';

export interface AuthDevice {
  id: string; // uuid v4
  label: string;
  pubkey: string; // base64 of the 32-byte X25519 static public key
  fingerprint: string; // lowercase hex of SHA-256(raw pubkey bytes)
  pairedAt: string; // ISO-8601
  lastSeenAt: string | null;
  lastAddress: string | null;
}

export class RegistryError extends Error {
  constructor(
    public code: 'not_found' | 'ambiguous' | 'duplicate',
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

interface AuthDeviceRow {
  id: string;
  label: string;
  pubkey: string;
  fingerprint: string;
  paired_at: string;
  last_seen_at: string | null;
  last_address: string | null;
}

function fromRow(row: AuthDeviceRow): AuthDevice {
  return {
    id: row.id,
    label: row.label,
    pubkey: row.pubkey,
    fingerprint: row.fingerprint,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    lastAddress: row.last_address,
  };
}

function fingerprintOf(pubkey: string): string {
  return new Bun.CryptoHasher('sha256').update(Buffer.from(pubkey, 'base64')).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export function addDevice(input: { label: string; pubkey: string; address?: string }): AuthDevice {
  const id = crypto.randomUUID();
  const fingerprint = fingerprintOf(input.pubkey);
  const pairedAt = new Date().toISOString();
  try {
    db.query(
      `INSERT INTO auth_devices (id, label, pubkey, fingerprint, paired_at, last_address)
       VALUES ($id, $label, $pubkey, $fingerprint, $pairedAt, $lastAddress)`,
    ).run({
      $id: id,
      $label: input.label,
      $pubkey: input.pubkey,
      $fingerprint: fingerprint,
      $pairedAt: pairedAt,
      $lastAddress: input.address ?? null,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new RegistryError('duplicate', 'a device with this pubkey is already registered');
    }
    throw err;
  }
  return {
    id,
    label: input.label,
    pubkey: input.pubkey,
    fingerprint,
    pairedAt,
    lastSeenAt: null,
    lastAddress: input.address ?? null,
  };
}

export function listDevices(): AuthDevice[] {
  const rows = db
    .query(
      `SELECT id, label, pubkey, fingerprint, paired_at, last_seen_at, last_address
       FROM auth_devices
       ORDER BY paired_at DESC, rowid DESC`,
    )
    .all() as AuthDeviceRow[];
  return rows.map(fromRow);
}

export function getDeviceByPubkey(pubkey: string): AuthDevice | null {
  const row = db
    .query(
      `SELECT id, label, pubkey, fingerprint, paired_at, last_seen_at, last_address
       FROM auth_devices
       WHERE pubkey = $pubkey`,
    )
    .get({ $pubkey: pubkey }) as AuthDeviceRow | null;
  return row ? fromRow(row) : null;
}
