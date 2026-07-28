import { z } from 'zod';
import { getSetting, setSetting } from './db';

const nonNegativeInt = z.number().int().nonnegative();

export const configSchema = z
  .object({
    notify: z.object({
      enabled: z.boolean(),
      url: z.string().url(),
      topic: z.string().max(256),
      token: z.string().min(1).max(4096).optional(),
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

export const DEFAULT_CONFIG: Config = {
  notify: { enabled: false, url: 'https://ntfy.sh', topic: '' },
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
      triggers: readTopLevel('triggers'),
      longJobSeconds: readScalar('longJobSeconds'),
      identity: readTopLevel('identity'),
      session: readTopLevel('session'),
    });
  }
  return cached;
}

export function patchConfig(partial: unknown): Config {
  const patch = z
    .object({
      notify: configSchema.shape.notify.partial().strict().optional(),
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
