export type ServerConfig = {
  notify: { enabled: boolean; url: string; topic: string; hasToken: boolean };
  triggers: { waiting: boolean; oscNotify: boolean; exit: boolean; longJob: boolean };
  longJobSeconds: number;
  identity: { name: string; color: string };
  session: { defaultShell: string; defaultCwd: string; scrollbackRows: number; silenceMs: number };
};

export type ServerSettingsDraft = ServerConfig & {
  notify: ServerConfig['notify'] & { token?: string };
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
    session: { ...config.session },
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
  const session = changedFields(config.session, draft.session);
  if (Object.keys(notify).length) patch.notify = notify;
  if (Object.keys(triggers).length) patch.triggers = triggers;
  if (config.longJobSeconds !== draft.longJobSeconds) patch.longJobSeconds = draft.longJobSeconds;
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
  try {
    new URL(draft.notify.url);
  } catch {
    errors.notifyUrl = 'Enter a valid notification URL.';
  }
  if (draft.notify.topic.length > 256) errors.notifyTopic = 'Topic must be at most 256 characters.';
  if (draft.notify.token !== undefined && (!draft.notify.token || draft.notify.token.length > 4096))
    errors.notifyToken = 'Token must be between 1 and 4096 characters.';
  if (!Number.isInteger(draft.longJobSeconds) || draft.longJobSeconds <= 0)
    errors.longJobSeconds = 'Long-job threshold must be a positive whole number.';
  if (!draft.session.defaultShell || draft.session.defaultShell.length > 4096)
    errors.defaultShell = 'Default shell must be between 1 and 4096 characters.';
  if (!draft.session.defaultCwd || draft.session.defaultCwd.length > 4096)
    errors.defaultCwd = 'Default directory must be between 1 and 4096 characters.';
  if (
    !Number.isInteger(draft.session.scrollbackRows) ||
    draft.session.scrollbackRows < 100 ||
    draft.session.scrollbackRows > 100000
  )
    errors.scrollbackRows = 'Scrollback must be between 100 and 100000 rows.';
  if (
    !Number.isInteger(draft.session.silenceMs) ||
    draft.session.silenceMs < 1000 ||
    draft.session.silenceMs > 3600000
  )
    errors.silenceMs = 'Silence threshold must be between 1000 and 3600000 ms.';
  return errors;
}
