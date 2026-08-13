import { useEffect, useMemo, useState } from 'react';
import { Modal, useWindowDimensions, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { validateAddress } from './address';
import { desktopLayout } from './desktopLayout';
import { confirmAction } from './dialog';
import { isDesktop } from './platform';
import {
  AdminDialog,
  type AdminOperation,
  ConnectionSection,
  HealthStatusBody,
  SettingsFormBody,
  SettingsHeader,
  type SettingsMessage,
  SettingsUnavailable,
} from './ServerSettingsSections';
import { Button, createStyles } from './ServerSettingsWidgets';
import {
  changeServerPassword,
  loadServerConfig,
  loadServerVersion,
  patchServerConfig,
  restartServer,
  sendServerNotificationTest,
  updateServer,
} from './serverConfig';
import {
  createServerSettingsDraft,
  isServerSettingsDirty,
  patchForDraft,
  type ServerConfig,
  type ServerSettingsDraft,
  validateServerSettingsDraft,
} from './serverSettingsModel';
import type { HostClient } from './tether/hostClient';
import type { HostHealthStatus } from './tether/hostHealth';
import type { HostProfile } from './tether/hostStore';

export function ServerSettings({
  visible,
  inline = false,
  host,
  client,
  health,
  onClose,
  onRetry,
  onUnauthorized,
  onIdentitySaved,
  onPasswordChanged,
  onConnectionSaved,
  onRemoveHost,
}: {
  visible: boolean;
  inline?: boolean;
  host: HostProfile | null;
  client: HostClient | null;
  health: HostHealthStatus;
  onClose: () => void;
  onRetry: () => void;
  onUnauthorized: () => void;
  onIdentitySaved: (identity: ServerConfig['identity']) => void;
  onPasswordChanged: (password: string) => Promise<void>;
  onConnectionSaved: (
    changes: Pick<HostProfile, 'host' | 'port'>,
    replacementPassword?: string,
  ) => Promise<void>;
  onRemoveHost: () => Promise<void>;
}) {
  const { theme } = useAppTheme();
  const { width } = useWindowDimensions();
  const desktopUi = desktopLayout(isDesktop, width) === 'desktop';
  const styles = createStyles(theme.colors, desktopUi);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [draft, setDraft] = useState<ServerSettingsDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<SettingsMessage | null>(null);
  const [admin, setAdmin] = useState<AdminOperation>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [connectionHost, setConnectionHost] = useState(host?.host ?? '');
  const [connectionPort, setConnectionPort] = useState(host?.port ?? '8085');
  const [replacementPassword, setReplacementPassword] = useState('');

  useEffect(() => {
    setConnectionHost(host?.host ?? '');
    setConnectionPort(host?.port ?? '8085');
    setReplacementPassword('');
  }, [host]);

  useEffect(() => {
    if (!visible || !client || health === 'unreachable' || health === 'unauthorized') return;
    setLoading(true);
    setMessage(null);
    void Promise.all([loadServerConfig(client), loadServerVersion(client)])
      .then(([nextConfig, nextVersion]) => {
        setConfig(nextConfig);
        const named = host?.name
          ? { ...nextConfig, identity: { ...nextConfig.identity, name: host.name } }
          : nextConfig;
        setDraft(createServerSettingsDraft(named));
        setVersion(nextVersion);
      })
      .catch((error) =>
        setMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : 'Could not load settings.',
        }),
      )
      .finally(() => setLoading(false));
  }, [client, health, visible, host?.name]);

  const dirty = useMemo(
    () => !!config && !!draft && isServerSettingsDirty(config, draft),
    [config, draft],
  );
  const readOnly = health === 'unreachable' || !draft;
  const validationErrors = useMemo(
    () => (draft ? validateServerSettingsDraft(draft) : {}),
    [draft],
  );
  const connectionDirty =
    !!host &&
    (connectionHost !== host.host ||
      connectionPort !== host.port ||
      replacementPassword.length > 0);
  const connectionValidation = validateAddress(connectionHost, connectionPort);
  const set = <K extends keyof ServerSettingsDraft>(key: K, value: ServerSettingsDraft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const close = async () => {
    if (
      dirty &&
      !(await confirmAction('Discard changes?', 'Your unsaved server settings will be lost.', {
        confirmLabel: 'Discard',
        destructive: true,
      }))
    )
      return;
    onClose();
  };
  const save = async () => {
    if (!config || !draft || !client) return;
    if (Object.keys(validateServerSettingsDraft(draft)).length) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await patchServerConfig(client, patchForDraft(config, draft));
      setConfig(next);
      setDraft(createServerSettingsDraft(next));
      onIdentitySaved(next.identity);
      setMessage({
        kind: 'success',
        text: 'Saved. Session defaults apply to newly started sessions.',
      });
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not save settings.',
      });
    } finally {
      setSaving(false);
    }
  };
  const saveConnection = async () => {
    if (!connectionDirty || !connectionValidation.ok) return;
    setSaving(true);
    setMessage(null);
    try {
      await onConnectionSaved(
        { host: connectionHost.trim(), port: connectionPort.trim() },
        replacementPassword || undefined,
      );
      setReplacementPassword('');
      setMessage({ kind: 'success', text: 'Connection saved.' });
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not save the connection.',
      });
    } finally {
      setSaving(false);
    }
  };
  const removeHost = async () => {
    if (
      !(await confirmAction(
        'Remove this host?',
        'Its saved password and cached sessions will be cleared.',
        { confirmLabel: 'Remove', destructive: true },
      ))
    )
      return;
    await onRemoveHost();
    onClose();
  };
  const sendTest = async () => {
    if (!config || !draft || !client) return;
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
  };
  const runAdmin = async () => {
    if (!client || !admin || !currentPassword) return;
    if (admin === 'password' && (!nextPassword || nextPassword !== confirmPassword)) {
      setMessage({ kind: 'error', text: 'New passwords must match.' });
      return;
    }
    setAdminBusy(true);
    setMessage(null);
    try {
      if (admin === 'password') {
        await changeServerPassword(client, currentPassword, nextPassword);
        await onPasswordChanged(nextPassword);
        setMessage({
          kind: 'success',
          text: 'Password changed. Existing token sessions remain connected.',
        });
      } else if (admin === 'update') {
        setMessage({
          kind: 'success',
          text: 'Updating… Sessions survive the restart and will reconnect.',
        });
        await updateServer(client, currentPassword);
        onRetry();
        let actual: string | null = null;
        for (let attempt = 0; attempt < 10 && !actual; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          actual = await loadServerVersion(client).catch(() => null);
        }
        setVersion(actual);
        setMessage({
          kind: 'success',
          text: actual
            ? `Updated. Server is now ${actual}.`
            : 'Update requested; waiting for server reconnect.',
        });
      } else {
        setMessage({ kind: 'success', text: 'Restarting… Sessions survive and will reconnect.' });
        await restartServer(client, currentPassword);
        onRetry();
      }
      setAdmin(null);
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Server operation failed.',
      });
    } finally {
      setAdminBusy(false);
    }
  };

  if (inline && !visible) return null;

  const connectionSection = (
    <ConnectionSection
      styles={styles}
      connectionHost={connectionHost}
      connectionPort={connectionPort}
      replacementPassword={replacementPassword}
      connectionDirty={connectionDirty}
      connectionOk={connectionValidation.ok}
      connectionReason={!connectionValidation.ok ? connectionValidation.reason : undefined}
      saving={saving}
      onHost={setConnectionHost}
      onPort={setConnectionPort}
      onPassword={setReplacementPassword}
      onSave={() => void saveConnection()}
    />
  );
  const removeHostButton = (
    <Button label="Remove this host" onPress={() => void removeHost()} tone="danger" />
  );
  const content =
    health === 'unauthorized' || health === 'unreachable' || (loading && !draft) ? (
      <HealthStatusBody
        styles={styles}
        accent={theme.colors.accent}
        connectionSection={connectionSection}
        removeHostButton={removeHostButton}
        kind={
          health === 'unauthorized'
            ? 'unauthorized'
            : health === 'unreachable'
              ? 'unreachable'
              : 'loading'
        }
        onUnauthorized={onUnauthorized}
        onRetry={onRetry}
      />
    ) : draft ? (
      <SettingsFormBody
        styles={styles}
        draft={draft}
        config={config}
        readOnly={readOnly}
        validationErrors={validationErrors}
        saving={saving}
        dirty={dirty}
        hasValidationErrors={Object.keys(validationErrors).length > 0}
        message={message}
        connectionSection={connectionSection}
        removeHostButton={removeHostButton}
        onIdentity={(identity) => set('identity', identity)}
        onPush={(push) => set('push', push)}
        onTriggers={(triggers) => set('triggers', triggers)}
        onLongJobSeconds={(longJobSeconds) => set('longJobSeconds', longJobSeconds)}
        onSession={(session) => set('session', session)}
        onAdmin={setAdmin}
        onTest={() => void sendTest()}
        onSave={() => void save()}
      />
    ) : (
      <SettingsUnavailable
        styles={styles}
        message={message?.text ?? 'Settings are unavailable.'}
        onRetry={onRetry}
      />
    );

  const body = (
    <View
      style={[styles.backdrop, inline && desktopUi ? styles.inlineBackdrop : styles.mobileBackdrop]}
    >
      <View style={[styles.panel, inline && styles.inlinePanel]}>
        <SettingsHeader
          styles={styles}
          name={host?.name ?? 'Host settings'}
          subtitle={`${host ? `${host.host}:${host.port}` : 'Server'}${version ? ` · ${version}` : ''}`}
          accent={host?.color ?? theme.colors.accent}
          closeLabel={inline ? 'Back to hosts' : 'Close server settings'}
          onClose={() => void close()}
        />
        {content}
        <AdminDialog
          styles={styles}
          admin={admin}
          currentPassword={currentPassword}
          nextPassword={nextPassword}
          confirmPassword={confirmPassword}
          adminBusy={adminBusy}
          onCurrentPassword={setCurrentPassword}
          onNextPassword={setNextPassword}
          onConfirmPassword={setConfirmPassword}
          onCancel={() => setAdmin(null)}
          onConfirm={() => void runAdmin()}
        />
      </View>
    </View>
  );

  if (inline) return body;
  return (
    <Modal
      visible={visible}
      animationType={desktopUi ? 'fade' : 'slide'}
      transparent={desktopUi}
      onRequestClose={() => void close()}
    >
      {body}
    </Modal>
  );
}
