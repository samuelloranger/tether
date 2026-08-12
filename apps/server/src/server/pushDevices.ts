import { db } from './db';

export interface PushDevice {
  deviceToken: string;
  secretKey: string;
  label: string | null;
}

interface Row {
  device_token: string;
  secret_key: string;
  label: string | null;
}

const toDevice = (row: Row): PushDevice => ({
  deviceToken: row.device_token,
  secretKey: row.secret_key,
  label: row.label,
});

/**
 * Register (or re-register) a device. APNs rotates device tokens, and the app
 * re-registers on every launch, so this is an upsert keyed on the token rather
 * than an insert that would accumulate duplicates.
 */
export function registerPushDevice(deviceToken: string, secretKey: string, label?: string): void {
  db.query(
    `INSERT INTO push_devices (device_token, secret_key, label)
     VALUES ($token, $key, $label)
     ON CONFLICT(device_token) DO UPDATE SET secret_key = $key, label = $label`,
  ).run({ $token: deviceToken, $key: secretKey, $label: label ?? null });
}

export function listPushDevices(): PushDevice[] {
  return (db.query('SELECT device_token, secret_key, label FROM push_devices').all() as Row[]).map(
    toDevice,
  );
}

/**
 * Forget a device. Called both when a user unregisters and when the relay
 * reports HTTP 410 — the relay is stateless, so pruning is our job.
 */
export function removePushDevice(deviceToken: string): void {
  db.query('DELETE FROM push_devices WHERE device_token = $token').run({ $token: deviceToken });
}

export function markPushDeviceUsed(deviceToken: string): void {
  db.query(
    'UPDATE push_devices SET last_used_at = CURRENT_TIMESTAMP WHERE device_token = $token',
  ).run({ $token: deviceToken });
}
