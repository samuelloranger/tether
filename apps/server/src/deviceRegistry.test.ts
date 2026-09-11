import { afterEach, expect, test } from 'bun:test';
import { db } from './db';
import { trackDeviceChannel } from './deviceChannels';
import {
  addDevice,
  deviceCount,
  getDeviceByPubkey,
  listDevices,
  RegistryError,
  renameDevice,
  resolveTarget,
  revokeDevice,
  touchDevice,
  upsertDevice,
} from './deviceRegistry';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/;

function pubkeyFill(byte: number): string {
  return Buffer.from(new Uint8Array(32).fill(byte)).toString('base64');
}

afterEach(() => {
  db.query('DELETE FROM auth_devices').run();
});

test('addDevice returns a uuid id, 64-hex fingerprint, and pairedAt', () => {
  const pubkey = pubkeyFill(7);
  const device = addDevice({ label: 'sam-iphone', pubkey });

  expect(device.label).toBe('sam-iphone');
  expect(device.pubkey).toBe(pubkey);
  expect(device.id).toMatch(UUID_V4);
  expect(device.fingerprint).toMatch(HEX_64);
  expect(device.fingerprint).toBe(
    new Bun.CryptoHasher('sha256').update(Buffer.from(pubkey, 'base64')).digest('hex'),
  );
  expect(device.pairedAt).toBeTruthy();
  expect(device.lastSeenAt).toBeNull();
  expect(device.lastAddress).toBeNull();
});

test('listDevices returns inserted rows newest-first', () => {
  const older = addDevice({ label: 'older', pubkey: pubkeyFill(1) });
  const newer = addDevice({ label: 'newer', pubkey: pubkeyFill(2) });

  const listed = listDevices();
  expect(listed.map((d) => d.id)).toEqual([newer.id, older.id]);
});

test('getDeviceByPubkey finds an inserted device and returns null for unknown', () => {
  const pubkey = pubkeyFill(9);
  const inserted = addDevice({ label: 'laptop', pubkey });

  const found = getDeviceByPubkey(pubkey);
  expect(found).not.toBeNull();
  expect(found?.id).toBe(inserted.id);
  expect(found?.label).toBe('laptop');
  expect(getDeviceByPubkey(pubkeyFill(3))).toBeNull();
});

test('upsertDevice inserts a new pubkey like addDevice', () => {
  const pubkey = pubkeyFill(5);
  const device = upsertDevice({ label: 'iphone', pubkey, address: '10.0.0.1' });
  expect(device.pubkey).toBe(pubkey);
  expect(device.label).toBe('iphone');
  expect(device.id).toMatch(UUID_V4);
  expect(device.lastAddress).toBe('10.0.0.1');
  expect(listDevices()).toHaveLength(1);
});

test('upsertDevice re-pairs an existing pubkey in place — no duplicate, updates label/address', () => {
  const pubkey = pubkeyFill(6);
  const first = upsertDevice({ label: 'iphone', pubkey, address: '10.0.0.1' });
  const second = upsertDevice({ label: 'iphone-2', pubkey, address: '10.0.0.2' });
  // Same identity (pubkey) → exactly one row, updated in place.
  expect(listDevices()).toHaveLength(1);
  expect(second.id).toBe(first.id);
  expect(second.pubkey).toBe(pubkey);
  expect(second.label).toBe('iphone-2');
  expect(second.lastAddress).toBe('10.0.0.2');
  expect(getDeviceByPubkey(pubkey)?.label).toBe('iphone-2');
});

test('a duplicate pubkey throws RegistryError duplicate', () => {
  const pubkey = pubkeyFill(7);
  addDevice({ label: 'first', pubkey });

  expect(() => addDevice({ label: 'second', pubkey })).toThrow(RegistryError);
  try {
    addDevice({ label: 'second', pubkey });
  } catch (err) {
    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).code).toBe('duplicate');
  }
});

function expectCode(fn: () => unknown, code: RegistryError['code']) {
  try {
    fn();
    throw new Error(`expected RegistryError(${code})`);
  } catch (err) {
    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).code).toBe(code);
  }
}

test('resolveTarget finds by exact id, exact label, and fingerprint prefix', () => {
  const device = addDevice({ label: 'sam-iphone', pubkey: pubkeyFill(11) });
  // A GUI revokes by the exact id it got from the device list.
  expect(resolveTarget(device.id).id).toBe(device.id);
  expect(resolveTarget('sam-iphone').id).toBe(device.id);
  expect(resolveTarget(device.fingerprint.slice(0, 8)).id).toBe(device.id);
});

test('resolveTarget throws not_found for no match and ambiguous for two hits', () => {
  addDevice({ label: 'phone', pubkey: pubkeyFill(21) });
  addDevice({ label: 'phone', pubkey: pubkeyFill(22) });
  expectCode(() => resolveTarget('no-such-device'), 'not_found');
  expectCode(() => resolveTarget('phone'), 'ambiguous');
});

test('revokeDevice removes the row and a second revoke throws not_found', () => {
  const device = addDevice({ label: 'doomed', pubkey: pubkeyFill(31) });
  const removed = revokeDevice('doomed');
  expect(removed.id).toBe(device.id);
  expect(getDeviceByPubkey(device.pubkey)).toBeNull();
  expectCode(() => revokeDevice('doomed'), 'not_found');
});

test('revokeDevice closes tracked live channels for that device only', () => {
  const deviceA = addDevice({ label: 'phone-a', pubkey: pubkeyFill(32) });
  const deviceB = addDevice({ label: 'phone-b', pubkey: pubkeyFill(33) });
  const closed: string[] = [];
  trackDeviceChannel(deviceA.id, () => closed.push('a'));
  trackDeviceChannel(deviceB.id, () => closed.push('b'));
  revokeDevice(deviceA.id);
  expect(closed).toEqual(['a']);
});

test('renameDevice changes the label and returns the updated device', () => {
  const device = addDevice({ label: 'old-name', pubkey: pubkeyFill(41) });
  const updated = renameDevice('old-name', 'new-name');
  expect(updated.id).toBe(device.id);
  expect(updated.label).toBe('new-name');
  expect(resolveTarget('new-name').id).toBe(device.id);
  expectCode(() => resolveTarget('old-name'), 'not_found');
});

test('touchDevice sets lastSeenAt and lastAddress, and is a no-op for unknown pubkey', () => {
  const device = addDevice({ label: 'laptop', pubkey: pubkeyFill(51) });
  touchDevice(device.pubkey, '10.0.0.8');
  const touched = getDeviceByPubkey(device.pubkey);
  expect(touched?.lastAddress).toBe('10.0.0.8');
  expect(touched?.lastSeenAt).toBeTruthy();
  expect(() => touchDevice(pubkeyFill(99), '1.2.3.4')).not.toThrow();
});

test('deviceCount reflects inserts and revokes', () => {
  expect(deviceCount()).toBe(0);
  addDevice({ label: 'a', pubkey: pubkeyFill(61) });
  addDevice({ label: 'b', pubkey: pubkeyFill(62) });
  expect(deviceCount()).toBe(2);
  revokeDevice('a');
  expect(deviceCount()).toBe(1);
});
