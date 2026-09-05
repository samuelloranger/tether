import { confirmAction } from './dialog';
import {
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

export type SettingsMessage = { kind: 'success' | 'error'; text: string };
export type AdminOperation = 'update' | 'restart' | null;

export async function confirmDiscardSettings(dirty: boolean): Promise<boolean> {
  if (!dirty) return true;
  return confirmAction('Discard changes?', 'Your unsaved server settings will be lost.', {
    confirmLabel: 'Discard',
    destructive: true,
  });
}

/**
 * Save server settings. Identity rename is applied ONLY when the patch
 * contains an `identity` key — matching the iOS fix in 46c1c78.
 */
export async function saveServerDraft(opts: {
  hostId: string;
  config: ServerConfig;
  draft: ServerSettingsDraft;
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
    const patch = patchForDraft(opts.config, opts.draft);
    const next = await patchServerConfig(opts.hostId, patch);
    opts.setConfig(next);
    opts.setDraft(createServerSettingsDraft(next));
    if (patch.identity) {
      opts.onIdentitySaved(next.identity);
    }
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

export async function confirmRemoveHost(): Promise<boolean> {
  return confirmAction('Remove this host?', 'Its pairing and cached sessions will be cleared.', {
    confirmLabel: 'Remove',
    destructive: true,
  });
}

export async function sendSettingsTest(
  hostId: string,
  setMessage: (message: SettingsMessage | null) => void,
): Promise<void> {
  setMessage(null);
  try {
    await sendServerNotificationTest(hostId);
    setMessage({ kind: 'success', text: 'Test notification sent.' });
  } catch (error) {
    setMessage({
      kind: 'error',
      text: error instanceof Error ? error.message : 'Test notification failed.',
    });
  }
}

async function waitForVersion(hostId: string): Promise<string | null> {
  let actual: string | null = null;
  for (let attempt = 0; attempt < 10 && !actual; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    actual = await loadServerVersion(hostId).catch(() => null);
  }
  return actual;
}

export async function runAdminOperation(opts: {
  hostId: string;
  admin: AdminOperation;
  onRetry: () => void;
  setMessage: (message: SettingsMessage | null) => void;
  setAdminBusy: (busy: boolean) => void;
  setVersion: (version: string | null) => void;
  resetAdmin: () => void;
}): Promise<void> {
  if (!opts.admin) return;
  opts.setAdminBusy(true);
  opts.setMessage(null);
  try {
    if (opts.admin === 'update') {
      opts.setMessage({
        kind: 'success',
        text: 'Updating… Sessions survive the restart and will reconnect.',
      });
      await updateServer(opts.hostId, '');
      opts.onRetry();
      const actual = await waitForVersion(opts.hostId);
      opts.setVersion(actual);
      opts.setMessage({
        kind: 'success',
        text: actual
          ? `Updated. Server is now ${actual}.`
          : 'Update requested; waiting for server reconnect.',
      });
    } else {
      opts.setMessage({
        kind: 'success',
        text: 'Restarting… Sessions survive and will reconnect.',
      });
      await restartServer(opts.hostId, '');
      opts.onRetry();
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
