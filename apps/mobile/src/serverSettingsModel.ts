export type ServerConfig = {
  notify: { enabled: boolean; url: string; topic: string; hasToken: boolean };
  triggers: { waiting: boolean; oscNotify: boolean; exit: boolean; longJob: boolean };
  longJobSeconds: number;
  identity: { name: string; color: string };
  session: { defaultShell: string; defaultCwd: string; scrollbackRows: number; silenceMs: number };
};

export type ServerSettingsDraft = Omit<ServerConfig, 'longJobSeconds' | 'session'> & {
  notify: ServerConfig['notify'] & { token?: string };
  longJobSeconds: string;
  session: Omit<ServerConfig['session'], 'scrollbackRows' | 'silenceMs'> & {
    scrollbackRows: string;
    silenceMs: string;
  };
};
export type ServerConfigPatch = Partial<{
  notify: Partial<Omit<ServerConfig['notify'], 'hasToken'>> & { token?: string };
  triggers: Partial<ServerConfig['triggers']>;
  longJobSeconds: number;
  identity: Partial<ServerConfig['identity']>;
  session: Partial<ServerConfig['session']>;
}>;
type NotifyPatch = NonNullable<ServerConfigPatch['notify']>;

export function createServerSettingsDraft(config: ServerConfig): ServerSettingsDraft {
  return {
    ...config,
    notify: { ...config.notify },
    triggers: { ...config.triggers },
    identity: { ...config.identity },
    longJobSeconds: String(config.longJobSeconds),
    session: {
      ...config.session,
      scrollbackRows: String(config.session.scrollbackRows),
      silenceMs: String(config.session.silenceMs),
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
  const notify = changedFields(config.notify, draft.notify, ['hasToken']) as NotifyPatch;
  if (draft.notify.token !== undefined) notify.token = draft.notify.token;
  const patch: ServerConfigPatch = {};
  const triggers = changedFields(config.triggers, draft.triggers);
  const identity = changedFields(config.identity, draft.identity);
  const session: NonNullable<ServerConfigPatch['session']> = {};
  if (config.session.defaultShell !== draft.session.defaultShell)
    session.defaultShell = draft.session.defaultShell;
  if (config.session.defaultCwd !== draft.session.defaultCwd)
    session.defaultCwd = draft.session.defaultCwd;
  const scrollbackRows = Number(draft.session.scrollbackRows);
  if (config.session.scrollbackRows !== scrollbackRows) session.scrollbackRows = scrollbackRows;
  const silenceMs = Number(draft.session.silenceMs);
  if (config.session.silenceMs !== silenceMs) session.silenceMs = silenceMs;
  if (Object.keys(notify).length) patch.notify = notify;
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

export type ServerSettingsErrors = Partial<Record<string, string>>;

export function validateServerSettingsDraft(draft: ServerSettingsDraft): ServerSettingsErrors {
  const errors: ServerSettingsErrors = {};
  if (!draft.identity.name || draft.identity.name.length > 100)
    errors.identityName = 'Name must be between 1 and 100 characters.';
  if (draft.identity.color.length > 32)
    errors.identityColor = 'Color must be at most 32 characters.';
  if (draft.notify.enabled) {
    try {
      new URL(draft.notify.url);
    } catch {
      errors.notifyUrl = 'Enter a valid notification URL.';
    }
    if (draft.notify.topic.length > 256)
      errors.notifyTopic = 'Topic must be at most 256 characters.';
  }
  if (draft.notify.token !== undefined && (!draft.notify.token || draft.notify.token.length > 4096))
    errors.notifyToken = 'Token must be between 1 and 4096 characters.';
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
  if (
    !Number.isInteger(Number(draft.session.silenceMs)) ||
    Number(draft.session.silenceMs) < 1000 ||
    Number(draft.session.silenceMs) > 3600000
  )
    errors.silenceMs = 'Silence threshold must be between 1000 and 3600000 ms.';
  return errors;
}
