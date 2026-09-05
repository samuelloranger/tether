import { homedir } from 'node:os';
import { z } from 'zod';
import { getSetting, setSetting } from './db';
import { logWarn } from './log';
import { describeShellSupport, getDefaultShell, type ShellSupport } from './ptyShell';

const nonNegativeInt = z.number().int().nonnegative();

export const configSchema = z
  .object({
    // Native push via the relay (pushRelay.ts). No URL here on purpose — the
    // relay is fixed by the app's signing identity, not chosen per server.
    push: z.object({ enabled: z.boolean() }),
    triggers: z.object({
      waiting: z.boolean(),
      // `.default(false)`, not a bare boolean: old stored rows predate this key, and
      // a required key would fail parsing and silently flip `waiting: false` back on.
      done: z.boolean().default(false),
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
  push: { enabled: false },
  triggers: { waiting: true, done: false, oscNotify: true, exit: false, longJob: true },
  longJobSeconds: 300,
  identity: { name: process.env.HOSTNAME || 'Tether', color: '#89b4fa' },
  session: {
    // getDefaultShell(), not $SHELL: Windows has no login shell, and Git Bash
    // exports SHELL=<its bash.exe>, handing sessions an MSYS shell with unresolvable paths.
    defaultShell: getDefaultShell(),
    // homedir() honours USERPROFILE on Windows, where HOME is usually unset —
    // the old `|| '/'` fallback was not a directory that exists there.
    defaultCwd: homedir(),
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
    logWarn(`Ignoring invalid stored config.${key}`);
    return structuredClone(DEFAULT_CONFIG[key]);
  }
}

function readScalar<K extends 'longJobSeconds'>(key: K): Config[K] {
  const raw = getSetting(`config.${key}`);
  if (!raw) return DEFAULT_CONFIG[key];
  try {
    return configSchema.shape[key].parse(JSON.parse(raw)) as Config[K];
  } catch {
    logWarn(`Ignoring invalid stored config.${key}`);
    return DEFAULT_CONFIG[key];
  }
}

export function getConfig(): Config {
  if (!cached) {
    cached = configSchema.parse({
      // Only the keys named here are read, so rows from removed sections
      // (`config.notify`) are inert rather than a parse failure that takes getConfig down.
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
    push: { ...current.push, ...patch.push },
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

/**
 * Derived state about the configured shell — reported, never patchable. A free-text
 * shell choice (e.g. Git Bash) can silently disable git/file-tree/upload; this surfaces that cost.
 */
export function getShellSupport(): ShellSupport {
  return describeShellSupport(getConfig().session.defaultShell);
}
