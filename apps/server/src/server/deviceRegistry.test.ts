import { afterEach, expect, test } from 'bun:test';
import { db } from './db';
import { addDevice, getDeviceByPubkey, listDevices, RegistryError } from './deviceRegistry';

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
