import { db } from './db';
import { removePushDevicesForAuthDevice } from './pushDevices';

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

const DEVICE_COLUMNS = 'id, label, pubkey, fingerprint, paired_at, last_seen_at, last_address';

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

/**
 * Enrol a device, idempotently. A brand-new pubkey is inserted like
 * `addDevice`; an already-registered pubkey (the same physical device pairing
 * again — e.g. after a client-side hiccup where the server enrolled but the
 * device never saw the verdict) is updated in place rather than rejected as a
 * duplicate. This is what the pairing flow uses so a re-pair always succeeds.
 */
export function upsertDevice(input: {
  label: string;
  pubkey: string;
  address?: string;
}): AuthDevice {
  const existing = getDeviceByPubkey(input.pubkey);
  if (!existing) return addDevice(input);
  const pairedAt = new Date().toISOString();
  db.query(
    `UPDATE auth_devices SET label = $label, last_address = $lastAddress, paired_at = $pairedAt
       WHERE pubkey = $pubkey`,
  ).run({
    $label: input.label,
    $lastAddress: input.address ?? null,
    $pairedAt: pairedAt,
    $pubkey: input.pubkey,
  });
  return { ...existing, label: input.label, lastAddress: input.address ?? null, pairedAt };
}

export function listDevices(): AuthDevice[] {
  const rows = db
    .query(
      `SELECT ${DEVICE_COLUMNS}
       FROM auth_devices
       ORDER BY paired_at DESC, rowid DESC`,
    )
    .all() as AuthDeviceRow[];
  return rows.map(fromRow);
}

export function getDeviceByPubkey(pubkey: string): AuthDevice | null {
  const row = db
    .query(`SELECT ${DEVICE_COLUMNS} FROM auth_devices WHERE pubkey = $pubkey`)
    .get({ $pubkey: pubkey }) as AuthDeviceRow | null;
  return row ? fromRow(row) : null;
}

export function getDeviceById(id: string): AuthDevice | null {
  const row = db
    .query(`SELECT ${DEVICE_COLUMNS} FROM auth_devices WHERE id = $id`)
    .get({ $id: id }) as AuthDeviceRow | null;
  return row ? fromRow(row) : null;
}

export function resolveTarget(target: string): AuthDevice {
  const rows = db
    .query(
      // Exact id first — a GUI revokes by the unambiguous id it got from the
      // device list; label and fingerprint-prefix are the CLI's human affordances.
      `SELECT id FROM auth_devices WHERE id = $t
       UNION
       SELECT id FROM auth_devices WHERE label = $t
       UNION
       SELECT id FROM auth_devices WHERE fingerprint LIKE $t || '%'`,
    )
    .all({ $t: target }) as { id: string }[];
  if (rows.length === 0) {
    throw new RegistryError('not_found', `no device matches '${target}'`);
  }
  if (rows.length > 1) {
    throw new RegistryError('ambiguous', `multiple devices match '${target}'`);
  }
  return getDeviceById(rows[0].id)!;
}

export function revokeDevice(target: string): AuthDevice {
  const device = resolveTarget(target);
  db.query('DELETE FROM auth_devices WHERE id = $id').run({ $id: device.id });
  removePushDevicesForAuthDevice(device.id);
  return device;
}

export function renameDevice(target: string, label: string): AuthDevice {
  const device = resolveTarget(target);
  db.query('UPDATE auth_devices SET label = $label WHERE id = $id').run({
    $id: device.id,
    $label: label,
  });
  return { ...device, label };
}

export function touchDevice(pubkey: string, address?: string): void {
  db.query(
    `UPDATE auth_devices
     SET last_seen_at = $now, last_address = COALESCE($address, last_address)
     WHERE pubkey = $pubkey`,
  ).run({
    $now: new Date().toISOString(),
    $address: address ?? null,
    $pubkey: pubkey,
  });
}

export function deviceCount(): number {
  const row = db.query('SELECT COUNT(*) AS n FROM auth_devices').get() as { n: number };
  return row.n;
}
