import { confirmAction } from './dialog';
import type { AdminOperation, SettingsMessage } from './ServerSettingsSections';
import {
  changeServerPassword,
  loadServerVersion,
  patchServerConfig,
  restartServer,
  sendServerNotificationTest,
  updateServer,
} from './serverConfig';
import {
  createServerSettingsDraft,
  patchForDraft,
  type ServerConfig,
  type ServerSettingsDraft,
  validateServerSettingsDraft,
} from './serverSettingsModel';
import type { HostClient } from './tether/hostClient';
import type { HostProfile } from './tether/hostStore';

export async function confirmDiscardSettings(dirty: boolean): Promise<boolean> {
  if (!dirty) return true;
  return confirmAction('Discard changes?', 'Your unsaved server settings will be lost.', {
    confirmLabel: 'Discard',
    destructive: true,
  });
}

export async function saveServerDraft(opts: {
  config: ServerConfig;
  draft: ServerSettingsDraft;
  client: HostClient;
  setConfig: (config: ServerConfig) => void;
  setDraft: (draft: ServerSettingsDraft) => void;
  setSaving: (saving: boolean) => void;
  setMessage: (message: SettingsMessage | null) => void;
  onIdentitySaved: (identity: ServerConfig['identity']) => void;
}): Promise<void> {
  if (Object.keys(validateServerSettingsDraft(opts.draft)).length) return;
  opts.setSaving(true);
  opts.setMessage(null);
  try {
    const next = await patchServerConfig(opts.client, patchForDraft(opts.config, opts.draft));
    opts.setConfig(next);
    opts.setDraft(createServerSettingsDraft(next));
    opts.onIdentitySaved(next.identity);
    opts.setMessage({
      kind: 'success',
      text: 'Saved. Session defaults apply to newly started sessions.',
    });
  } catch (error) {
    opts.setMessage({
      kind: 'error',
      text: error instanceof Error ? error.message : 'Could not save settings.',
    });
  } finally {
    opts.setSaving(false);
  }
}

export async function saveHostConnection(opts: {
  connectionDirty: boolean;
  connectionOk: boolean;
  connectionHost: string;
  connectionPort: string;
  replacementPassword: string;
  setSaving: (saving: boolean) => void;
  setMessage: (message: SettingsMessage | null) => void;
  setReplacementPassword: (value: string) => void;
  onConnectionSaved: (
    changes: Pick<HostProfile, 'host' | 'port'>,
    replacementPassword?: string,
  ) => Promise<void>;
}): Promise<void> {
  if (!opts.connectionDirty || !opts.connectionOk) return;
  opts.setSaving(true);
  opts.setMessage(null);
  try {
    await opts.onConnectionSaved(
      { host: opts.connectionHost.trim(), port: opts.connectionPort.trim() },
      opts.replacementPassword || undefined,
    );
    opts.setReplacementPassword('');
    opts.setMessage({ kind: 'success', text: 'Connection saved.' });
  } catch (error) {
    opts.setMessage({
      kind: 'error',
      text: error instanceof Error ? error.message : 'Could not save the connection.',
    });
  } finally {
    opts.setSaving(false);
  }
}

export async function confirmRemoveHost(): Promise<boolean> {
  return confirmAction(
    'Remove this host?',
    'Its saved password and cached sessions will be cleared.',
    { confirmLabel: 'Remove', destructive: true },
  );
}

export async function sendSettingsTest(
  client: HostClient,
  setMessage: (message: SettingsMessage | null) => void,
): Promise<void> {
  setMessage(null);
  try {
    await sendServerNotificationTest(client);
    setMessage({ kind: 'success', text: 'Test notification sent.' });
  } catch (error) {
    setMessage({
      kind: 'error',
      text: error instanceof Error ? error.message : 'Test notification failed.',
    });
  }
}

async function waitForVersion(client: HostClient): Promise<string | null> {
  let actual: string | null = null;
  for (let attempt = 0; attempt < 10 && !actual; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    actual = await loadServerVersion(client).catch(() => null);
  }
  return actual;
}

async function runPasswordAdmin(
  client: HostClient,
  currentPassword: string,
  nextPassword: string,
  onPasswordChanged: (password: string) => Promise<void>,
  setMessage: (message: SettingsMessage | null) => void,
): Promise<void> {
  await changeServerPassword(client, currentPassword, nextPassword);
  await onPasswordChanged(nextPassword);
  setMessage({
    kind: 'success',
    text: 'Password changed. Existing token sessions remain connected.',
  });
}

async function runUpdateAdmin(
  client: HostClient,
  currentPassword: string,
  onRetry: () => void,
  setVersion: (version: string | null) => void,
  setMessage: (message: SettingsMessage | null) => void,
): Promise<void> {
  setMessage({
    kind: 'success',
    text: 'Updating… Sessions survive the restart and will reconnect.',
  });
  await updateServer(client, currentPassword);
  onRetry();
  const actual = await waitForVersion(client);
  setVersion(actual);
  setMessage({
    kind: 'success',
    text: actual
      ? `Updated. Server is now ${actual}.`
      : 'Update requested; waiting for server reconnect.',
  });
}

async function runRestartAdmin(
  client: HostClient,
  currentPassword: string,
  onRetry: () => void,
  setMessage: (message: SettingsMessage | null) => void,
): Promise<void> {
  setMessage({ kind: 'success', text: 'Restarting… Sessions survive and will reconnect.' });
  await restartServer(client, currentPassword);
  onRetry();
}

export async function runAdminOperation(opts: {
  client: HostClient;
  admin: AdminOperation;
  currentPassword: string;
  nextPassword: string;
  confirmPassword: string;
  onPasswordChanged: (password: string) => Promise<void>;
  onRetry: () => void;
  setMessage: (message: SettingsMessage | null) => void;
  setAdminBusy: (busy: boolean) => void;
  setVersion: (version: string | null) => void;
  resetAdmin: () => void;
}): Promise<void> {
  if (!opts.admin || !opts.currentPassword) return;
  if (
    opts.admin === 'password' &&
    (!opts.nextPassword || opts.nextPassword !== opts.confirmPassword)
  ) {
    opts.setMessage({ kind: 'error', text: 'New passwords must match.' });
    return;
  }
  opts.setAdminBusy(true);
  opts.setMessage(null);
  try {
    if (opts.admin === 'password') {
      await runPasswordAdmin(
        opts.client,
        opts.currentPassword,
        opts.nextPassword,
        opts.onPasswordChanged,
        opts.setMessage,
      );
    } else if (opts.admin === 'update') {
      await runUpdateAdmin(
        opts.client,
        opts.currentPassword,
        opts.onRetry,
        opts.setVersion,
        opts.setMessage,
      );
    } else {
      await runRestartAdmin(opts.client, opts.currentPassword, opts.onRetry, opts.setMessage);
    }
    opts.resetAdmin();
  } catch (error) {
    opts.setMessage({
      kind: 'error',
      text: error instanceof Error ? error.message : 'Server operation failed.',
    });
  } finally {
    opts.setAdminBusy(false);
  }
}
