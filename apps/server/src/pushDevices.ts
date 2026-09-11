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
export function registerPushDevice(
  deviceToken: string,
  secretKey: string,
  label?: string,
  authDeviceId?: string | null,
): void {
  db.query(
    `INSERT INTO push_devices (device_token, secret_key, label, auth_device_id)
     VALUES ($token, $key, $label, $authDeviceId)
     ON CONFLICT(device_token) DO UPDATE SET
       secret_key = $key,
       label = $label,
       auth_device_id = COALESCE($authDeviceId, push_devices.auth_device_id)`,
  ).run({
    $token: deviceToken,
    $key: secretKey,
    $label: label ?? null,
    $authDeviceId: authDeviceId ?? null,
  });
}

export function listPushDevices(): PushDevice[] {
  return (db.query('SELECT device_token, secret_key, label FROM push_devices').all() as Row[]).map(
    toDevice,
  );
}

export function countPushDevices(): number {
  return (db.query('SELECT COUNT(*) AS n FROM push_devices').get() as { n: number }).n;
}

/**
 * Forget a device. Called both when a user unregisters and when the relay
 * reports HTTP 410 — the relay is stateless, so pruning is our job.
 */
export function removePushDevice(deviceToken: string): void {
  db.query('DELETE FROM push_devices WHERE device_token = $token').run({ $token: deviceToken });
}

export function removePushDevicesForAuthDevice(authDeviceId: string): number {
  const result = db
    .query('DELETE FROM push_devices WHERE auth_device_id = $id')
    .run({ $id: authDeviceId });
  return result.changes;
}

export function markPushDeviceUsed(deviceToken: string): void {
  db.query(
    'UPDATE push_devices SET last_used_at = CURRENT_TIMESTAMP WHERE device_token = $token',
  ).run({ $token: deviceToken });
}
