import { expect, test } from 'bun:test';
import { formatDeviceTable, parseDeviceArgs, runDevice } from './deviceCli';
import { type AuthDevice, RegistryError } from './deviceRegistry';

test('parseDeviceArgs maps list, revoke, and rename forms', () => {
  expect(parseDeviceArgs([])).toEqual({ kind: 'list' });
  expect(parseDeviceArgs(['revoke', 'sam-iphone'])).toEqual({
    kind: 'revoke',
    target: 'sam-iphone',
  });
  expect(parseDeviceArgs(['rename', '7q4k', 'laptop'])).toEqual({
    kind: 'rename',
    target: '7q4k',
    label: 'laptop',
  });
});

test('parseDeviceArgs throws a usage message for malformed argv', () => {
  expect(() => parseDeviceArgs(['revoke'])).toThrow(/usage/i);
  expect(() => parseDeviceArgs(['bogus'])).toThrow(/usage/i);
  expect(() => parseDeviceArgs(['rename', '7q4k'])).toThrow(/usage/i);
});

function sampleDevice(overrides: Partial<AuthDevice> = {}): AuthDevice {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    label: 'sam-iphone',
    pubkey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    fingerprint: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    pairedAt: '2026-09-04T12:00:00.000Z',
    lastSeenAt: null,
    lastAddress: null,
    ...overrides,
  };
}

test('formatDeviceTable renders header and a device row', () => {
  const table = formatDeviceTable([sampleDevice()]);
  expect(table).toContain('NAME');
  expect(table).toContain('FINGERPRINT');
  expect(table).toContain('PAIRED');
  expect(table).toContain('LAST SEEN');
  expect(table).toContain('ADDRESS');
  expect(table).toContain('sam-iphone');
  expect(table).toContain('abcdef01');
  const dataRow = table.split('\n')[1] ?? '';
  expect(dataRow).toContain('-');
});

test('runDevice lists, reports not-found revoke, and succeeds on rename', () => {
  const device = sampleDevice();
  const deps = {
    listDevices: () => [device],
    revokeDevice: (target: string): AuthDevice => {
      throw new RegistryError('not_found', `no device matches '${target}'`);
    },
    renameDevice: (_target: string, label: string): AuthDevice => ({ ...device, label }),
  };

  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    const listed = runDevice({ kind: 'list' }, deps);
    expect(listed).toEqual({ ok: true });
    expect(logs.join('\n')).toContain('NAME');

    const revoked = runDevice({ kind: 'revoke', target: 'ghost' }, deps);
    expect(revoked).toEqual({ ok: false });
    expect(errors.join('\n')).toMatch(/no device/i);

    const renamed = runDevice({ kind: 'rename', target: 'sam-iphone', label: 'laptop' }, deps);
    expect(renamed).toEqual({ ok: true });
    expect(logs.join('\n')).toContain('Renamed to laptop.');
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});
