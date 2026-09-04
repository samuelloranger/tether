import {
  type AuthDevice,
  RegistryError,
  listDevices as registryList,
  renameDevice as registryRename,
  revokeDevice as registryRevoke,
} from './deviceRegistry';

export type DeviceArgs =
  | { kind: 'list' }
  | { kind: 'revoke'; target: string }
  | { kind: 'rename'; target: string; label: string };

const USAGE = 'Usage: tether device revoke <target> | rename <target> <name>';

export function parseDeviceArgs(argv: string[]): DeviceArgs {
  if (argv.length === 0) return { kind: 'list' };
  const [sub, ...rest] = argv;
  if (sub === 'revoke') {
    if (rest.length !== 1 || !rest[0]) throw new Error('Usage: tether device revoke <target>');
    return { kind: 'revoke', target: rest[0] };
  }
  if (sub === 'rename') {
    if (rest.length < 2 || !rest[0] || !rest[1]) {
      throw new Error('Usage: tether device rename <target> <name>');
    }
    return { kind: 'rename', target: rest[0], label: rest.slice(1).join(' ') };
  }
  throw new Error(USAGE);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function formatDeviceTable(devices: AuthDevice[]): string {
  const rows = devices.map((d) => ({
    name: d.label,
    fingerprint: d.fingerprint.slice(0, 8),
    paired: d.pairedAt,
    lastSeen: d.lastSeenAt ?? '-',
    address: d.lastAddress ?? '-',
  }));
  const header = {
    name: 'NAME',
    fingerprint: 'FINGERPRINT',
    paired: 'PAIRED',
    lastSeen: 'LAST SEEN',
    address: 'ADDRESS',
  };
  const cols = ['name', 'fingerprint', 'paired', 'lastSeen', 'address'] as const;
  const widths = Object.fromEntries(
    cols.map((col) => [col, Math.max(header[col].length, ...rows.map((r) => r[col].length))]),
  ) as Record<(typeof cols)[number], number>;
  const line = (row: typeof header) => cols.map((col) => pad(row[col], widths[col])).join('  ');
  return [line(header), ...rows.map(line)].join('\n');
}

export interface DeviceCliDeps {
  listDevices?: () => AuthDevice[];
  revokeDevice?: (target: string) => AuthDevice;
  renameDevice?: (target: string, label: string) => AuthDevice;
}

export function runDevice(args: DeviceArgs, deps: DeviceCliDeps = {}): { ok: boolean } {
  const list = deps.listDevices ?? registryList;
  const revoke = deps.revokeDevice ?? registryRevoke;
  const rename = deps.renameDevice ?? registryRename;
  try {
    if (args.kind === 'list') {
      console.log(formatDeviceTable(list()));
      return { ok: true };
    }
    if (args.kind === 'revoke') {
      const device = revoke(args.target);
      console.log(`Revoked ${device.label} (${device.fingerprint.slice(0, 8)}).`);
      return { ok: true };
    }
    const device = rename(args.target, args.label);
    console.log(`Renamed to ${device.label}.`);
    return { ok: true };
  } catch (err) {
    if (err instanceof RegistryError) {
      console.error(friendlyRegistryError(err));
      return { ok: false };
    }
    throw err;
  }
}

function friendlyRegistryError(err: RegistryError): string {
  switch (err.code) {
    case 'not_found':
      return 'No device matches that target.';
    case 'ambiguous':
      return 'Multiple devices match that target; be more specific.';
    case 'duplicate':
      return 'A device with that public key is already registered.';
  }
}
