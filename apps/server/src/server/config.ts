import { homedir } from 'node:os';
import { z } from 'zod';
import { getSetting, setSetting } from './db';
import { logWarn } from './log';
import { describeShellSupport, getDefaultShell, type ShellSupport } from './ptyShell';

const nonNegativeInt = z.number().int().nonnegative();

export const configSchema = z
  .object({
    // Native push, delivered through the relay in `pushRelay.ts`. There is no
    // URL here on purpose: the relay is fixed by the app's signing identity,
    // not chosen per server. See pushRelay.ts.
    push: z.object({ enabled: z.boolean() }),
    triggers: z.object({
      waiting: z.boolean(),
      // `.default(false)` rather than a bare boolean, and not for style: every
      // stored `config.triggers` row predates this key, and `readTopLevel`
      // reacts to a parse failure by discarding the WHOLE section for defaults.
      // A required key would silently flip a user's `waiting: false` back on.
      // The default makes the key optional on input while the parsed type stays
      // `boolean`, so nothing downstream changes.
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
  triggers: { waiting: true, done: false, oscNotify: true, exit: true, longJob: true },
  longJobSeconds: 300,
  identity: { name: process.env.HOSTNAME || 'Tether', color: '#89b4fa' },
  session: {
    // getDefaultShell() rather than $SHELL directly: on Windows there is no
    // login shell to read, and Git for Windows exports SHELL=<its bash.exe> to
    // everything it launches — so a daemon started from a Git Bash prompt used
    // to hand every session an MSYS shell reporting /c/Users/... paths that no
    // Windows API can resolve. On POSIX it still resolves to the user's shell.
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
      // Only the keys named here are read, so rows left behind by removed
      // sections (`config.notify` on servers that predate native push) are
      // inert rather than a parse failure that would take getConfig — and
      // therefore the server — down. Same reason `push` tolerates a missing
      // row: it did not exist before v2.8.
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
 * How well the *currently configured* default shell integrates with tether —
 * derived state about a setting, in the same family as `pushDevices` and `tls`:
 * reported so a client can explain itself, never patchable.
 *
 * `session.defaultShell` is a free-text field a client may set to anything, and
 * one of those anythings (an MSYS/Git-for-Windows bash) silently disables the
 * git, file-tree and upload features — see describeShellSupport in ptyShell.ts.
 * The choice is deliberately not rejected: an advanced user may want that shell
 * and accept the cost. This is how they find out they are paying it.
 */
export function getShellSupport(): ShellSupport {
  return describeShellSupport(getConfig().session.defaultShell);
}
