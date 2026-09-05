import { afterEach, expect, test } from 'bun:test';
import { db } from './db';
import { addDevice, revokeDevice } from './deviceRegistry';
import { listPushDevices, registerPushDevice, removePushDevicesForAuthDevice } from './pushDevices';

function pubkeyFill(byte: number): string {
  return Buffer.from(new Uint8Array(32).fill(byte)).toString('base64');
}

const key = Buffer.alloc(32, 9).toString('base64');

afterEach(() => {
  db.query('DELETE FROM push_devices').run();
  db.query('DELETE FROM auth_devices').run();
});

test('register with authDeviceId; revoke deletes that row and leaves a null-id row', () => {
  const a = addDevice({ label: 'a', pubkey: pubkeyFill(1) });
  registerPushDevice('tok-a', key, 'phone', a.id);
  registerPushDevice('tok-legacy', key, 'old', null);
  expect(removePushDevicesForAuthDevice(a.id)).toBe(1);
  revokeDevice(a.id);
  const left = listPushDevices();
  expect(left.map((d) => d.deviceToken)).toEqual(['tok-legacy']);
});
