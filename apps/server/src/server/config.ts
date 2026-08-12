import { z } from 'zod';
import { getSetting, setSetting } from './db';

const nonNegativeInt = z.number().int().nonnegative();

export const PRIVATE_NOTIFY_URL_ERROR =
  'Notification URL resolves to a private address. Set TETHER_ALLOW_PRIVATE_NOTIFY_URL=1 to allow it.';

export class PrivateNotifyUrlError extends Error {
  code = 'private_notify_url';
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false;
  const [first, second] = octets;
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateIpv4(normalized)) return true;
  const mappedIpv4 = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4 && isPrivateIpv4(mappedIpv4[1])) return true;
  return (
    normalized === '::1' ||
    /^fe[89ab][0-9a-f]*:/.test(normalized) ||
    /^[fd][0-9a-f]*:/.test(normalized)
  );
}

function hasPrivateNotifyHost(url: string): boolean {
  try {
    return isPrivateAddress(new URL(url).hostname);
  } catch {
    return false;
  }
}

const notifyUrlSchema = z
  .string()
  .url()
  .refine(
    (url) => process.env.TETHER_ALLOW_PRIVATE_NOTIFY_URL === '1' || !hasPrivateNotifyHost(url),
    PRIVATE_NOTIFY_URL_ERROR,
  );

export const configSchema = z
  .object({
    notify: z.object({
      enabled: z.boolean(),
      url: notifyUrlSchema,
      topic: z.string().max(256),
      token: z.string().min(1).max(4096).optional(),
    }),
    // Native APNs push, delivered through a relay. Independent of `notify`
    // (ntfy) on purpose — both can run, and a server that wants nothing to do
    // with a relay simply leaves this disabled.
    //
    // relayUrl has no baked-in default: the relay is separate infrastructure,
    // and hardcoding one operator's hostname here would both advertise their
    // deployment and make every server point at it by accident.
    push: z.object({
      enabled: z.boolean(),
      relayUrl: z.string().url().max(500).or(z.literal('')),
    }),
    triggers: z.object({
      waiting: z.boolean(),
      oscNotify: z.boolean(),
      exit: z.boolean(),
      longJob: z.boolean(),
    }),
    longJobSeconds: z.number().int().positive(),
    identity: z.object({ name: z.string().min(1).max(100), color: z.string().max(32) }),
    session: z.object({
      defaultShell: z.string().min(1).max(4096),
      defaultCwd: z.string().min(1).max(4096),
      scrollbackRows: nonNegativeInt.min(100).max(100_000),
      silenceMs: nonNegativeInt.min(1000).max(3_600_000),
    }),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type ConfigPatch = { [K in keyof Config]?: Partial<Config[K]> };

type NotifyUrlLookup = (hostname: string) => Promise<Array<{ address: string }>>;

export async function validateNotifyUrl(
  url: string,
  lookup: NotifyUrlLookup = (hostname) => Bun.dns.lookup(hostname),
): Promise<void> {
  if (process.env.TETHER_ALLOW_PRIVATE_NOTIFY_URL === '1') return;
  const hostname = new URL(url).hostname;
  const addresses = hasPrivateNotifyHost(url)
    ? [hostname]
    : await lookup(hostname).then(
        (records) => records.map((record) => record.address),
        () => [],
      );
  if (addresses.some(isPrivateAddress)) throw new PrivateNotifyUrlError(PRIVATE_NOTIFY_URL_ERROR);
}

export const DEFAULT_CONFIG: Config = {
  notify: { enabled: false, url: 'https://ntfy.sh', topic: '' },
  push: { enabled: false, relayUrl: process.env.TETHER_PUSH_RELAY_URL ?? '' },
  triggers: { waiting: true, oscNotify: true, exit: true, longJob: true },
  longJobSeconds: 300,
  identity: { name: process.env.HOSTNAME || 'Tether', color: '#89b4fa' },
  session: {
    defaultShell: process.env.SHELL || 'bash',
    defaultCwd: process.env.HOME || '/',
    scrollbackRows: 2000,
    silenceMs: 15_000,
  },
};

let cached: Config | null = null;

function readTopLevel<K extends keyof Config>(key: K): Config[K] {
  const raw = getSetting(`config.${key}`);
  if (!raw) return structuredClone(DEFAULT_CONFIG[key]);
  try {
    return configSchema.shape[key].parse(JSON.parse(raw)) as Config[K];
  } catch {
    console.warn(`Ignoring invalid stored config.${key}`);
    return structuredClone(DEFAULT_CONFIG[key]);
  }
}

function readScalar<K extends 'longJobSeconds'>(key: K): Config[K] {
  const raw = getSetting(`config.${key}`);
  if (!raw) return DEFAULT_CONFIG[key];
  try {
    return configSchema.shape[key].parse(JSON.parse(raw)) as Config[K];
  } catch {
    console.warn(`Ignoring invalid stored config.${key}`);
    return DEFAULT_CONFIG[key];
  }
}

export function getConfig(): Config {
  if (!cached) {
    cached = configSchema.parse({
      notify: readTopLevel('notify'),
      // Servers upgrading from before push existed have no stored row here;
      // readTopLevel falls back to the default rather than failing the parse
      // and taking getConfig — and therefore the server — down.
      push: readTopLevel('push'),
      triggers: readTopLevel('triggers'),
      longJobSeconds: readScalar('longJobSeconds'),
      identity: readTopLevel('identity'),
      session: readTopLevel('session'),
    });
  }
  return cached;
}

export async function patchConfig(partial: unknown): Promise<Config> {
  const patch = z
    .object({
      notify: configSchema.shape.notify.partial().strict().optional(),
      push: configSchema.shape.push.partial().strict().optional(),
      triggers: configSchema.shape.triggers.partial().strict().optional(),
      longJobSeconds: configSchema.shape.longJobSeconds.optional(),
      identity: configSchema.shape.identity.partial().strict().optional(),
      session: configSchema.shape.session.partial().strict().optional(),
    })
    .strict()
    .parse(partial);
  const current = getConfig();
  const next = configSchema.parse({
    ...current,
    ...patch,
    notify: { ...current.notify, ...patch.notify },
    triggers: { ...current.triggers, ...patch.triggers },
    identity: { ...current.identity, ...patch.identity },
    session: { ...current.session, ...patch.session },
  });
  await validateNotifyUrl(next.notify.url);
  for (const key of Object.keys(patch) as (keyof Config)[]) {
    setSetting(`config.${key}`, JSON.stringify(next[key]));
  }
  cached = next;
  return next;
}

export function resetConfigCache(): void {
  cached = null;
}

export function redactConfig(
  config: Config = getConfig(),
): Omit<Config, 'notify'> & { notify: Omit<Config['notify'], 'token'> & { hasToken: boolean } } {
  const { token: _token, ...notify } = config.notify;
  return { ...config, notify: { ...notify, hasToken: !!_token } };
}
