export type ServerConfig = {
  push: { enabled: boolean };
  pushDevices: number;
  triggers: { waiting: boolean; oscNotify: boolean; exit: boolean; longJob: boolean };
  longJobSeconds: number;
  identity: { name: string; color: string };
  session: { defaultShell: string; defaultCwd: string; scrollbackRows: number; silenceMs: number };
  tls?: unknown;
};

export type ServerSettingsDraft = Omit<ServerConfig, 'longJobSeconds' | 'session' | 'tls'> & {
  longJobSeconds: string;
  session: Omit<ServerConfig['session'], 'scrollbackRows' | 'silenceMs'> & {
    scrollbackRows: string;
    silenceMs: string;
  };
};

export type ServerConfigPatch = Partial<{
  push: Partial<ServerConfig['push']>;
  triggers: Partial<ServerConfig['triggers']>;
  longJobSeconds: number;
  identity: Partial<ServerConfig['identity']>;
  session: Partial<ServerConfig['session']>;
}>;

export function createServerSettingsDraft(config: ServerConfig): ServerSettingsDraft {
  return {
    ...config,
    push: { ...config.push },
    triggers: { ...config.triggers },
    identity: { ...config.identity },
    longJobSeconds: String(config.longJobSeconds),
    session: {
      ...config.session,
      scrollbackRows: String(config.session.scrollbackRows),
      silenceMs: String(config.session.silenceMs / 1000),
    },
  };
}

function changedFields<T extends object>(before: T, after: T, omit: readonly (keyof T)[] = []) {
  const changed: Partial<T> = {};
  for (const key of Object.keys(before) as (keyof T)[])
    if (!omit.includes(key) && before[key] !== after[key]) changed[key] = after[key];
  return changed;
}

export function patchForDraft(config: ServerConfig, draft: ServerSettingsDraft): ServerConfigPatch {
  const patch: ServerConfigPatch = {};
  const push = changedFields(config.push, draft.push);
  const triggers = changedFields(config.triggers, draft.triggers);
  const identity = changedFields(config.identity, draft.identity);
  const session: NonNullable<ServerConfigPatch['session']> = {};
  if (config.session.defaultShell !== draft.session.defaultShell)
    session.defaultShell = draft.session.defaultShell;
  if (config.session.defaultCwd !== draft.session.defaultCwd)
    session.defaultCwd = draft.session.defaultCwd;
  const scrollbackRows = Number(draft.session.scrollbackRows);
  if (config.session.scrollbackRows !== scrollbackRows) session.scrollbackRows = scrollbackRows;
  const silenceMs = Number(draft.session.silenceMs) * 1000;
  if (config.session.silenceMs !== silenceMs) session.silenceMs = silenceMs;
  if (Object.keys(push).length) patch.push = push;
  if (Object.keys(triggers).length) patch.triggers = triggers;
  const longJobSeconds = Number(draft.longJobSeconds);
  if (config.longJobSeconds !== longJobSeconds) patch.longJobSeconds = longJobSeconds;
  if (Object.keys(identity).length) patch.identity = identity;
  if (Object.keys(session).length) patch.session = session;
  return patch;
}

export function isServerSettingsDirty(config: ServerConfig, draft: ServerSettingsDraft): boolean {
  return Object.keys(patchForDraft(config, draft)).length > 0;
}

export function pushStatusHint(enabled: boolean, deviceCount: number): string {
  if (!enabled) return 'Off. Nothing is sent to Apple, and no notification leaves this server.';
  if (deviceCount === 0)
    return 'On, but no device has registered yet. Only the iOS app can receive push.';
  const devices = `${deviceCount} device${deviceCount === 1 ? '' : 's'}`;
  return `On. Notifications go to ${devices} — not this desktop; only the iOS app can receive push.`;
}

export type ServerSettingsErrors = Partial<Record<string, string>>;

export function validateServerSettingsDraft(draft: ServerSettingsDraft): ServerSettingsErrors {
  const errors: ServerSettingsErrors = {};
  if (!draft.identity.name || draft.identity.name.length > 100)
    errors.identityName = 'Name must be between 1 and 100 characters.';
  if (draft.identity.color.length > 32)
    errors.identityColor = 'Color must be at most 32 characters.';
  const longJobSeconds = Number(draft.longJobSeconds);
  if (!Number.isInteger(longJobSeconds) || longJobSeconds <= 0)
    errors.longJobSeconds = 'Long-job threshold must be a positive whole number.';
  if (!draft.session.defaultShell || draft.session.defaultShell.length > 4096)
    errors.defaultShell = 'Default shell must be between 1 and 4096 characters.';
  if (!draft.session.defaultCwd || draft.session.defaultCwd.length > 4096)
    errors.defaultCwd = 'Default directory must be between 1 and 4096 characters.';
  if (
    !Number.isInteger(Number(draft.session.scrollbackRows)) ||
    Number(draft.session.scrollbackRows) < 100 ||
    Number(draft.session.scrollbackRows) > 100000
  )
    errors.scrollbackRows = 'Scrollback must be between 100 and 100000 rows.';
  const silenceSeconds = Number(draft.session.silenceMs);
  if (!Number.isFinite(silenceSeconds) || silenceSeconds < 1 || silenceSeconds > 3600)
    errors.silenceMs = 'Enter a value from 1 to 3600 seconds.';
  else if (!Number.isInteger(silenceSeconds * 1000))
    errors.silenceMs = 'Enter seconds to the nearest millisecond.';
  return errors;
}
