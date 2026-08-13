import type { ReactNode } from 'react';
import { Modal, useWindowDimensions, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { desktopLayout } from './desktopLayout';
import { isDesktop } from './platform';
import {
  AdminDialog,
  ConnectionSection,
  HealthStatusBody,
  SettingsFormBody,
  SettingsHeader,
  SettingsUnavailable,
} from './ServerSettingsSections';
import { Button, createStyles } from './ServerSettingsWidgets';
import type { ServerSettingsProps } from './useServerSettings';
import { useServerSettings } from './useServerSettings';

export type { ServerSettingsProps };

type Settings = ReturnType<typeof useServerSettings>;
type Styles = ReturnType<typeof createStyles>;
type ContentProps = { p: ServerSettingsProps; s: Settings; styles: Styles; accent: string };

function HostConnection({ s, styles }: { s: Settings; styles: Styles }) {
  return (
    <ConnectionSection
      styles={styles}
      connectionHost={s.connectionHost}
      connectionPort={s.connectionPort}
      replacementPassword={s.replacementPassword}
      connectionDirty={s.connectionDirty}
      connectionOk={s.connectionOk}
      connectionReason={s.connectionReason}
      saving={s.saving}
      onHost={s.setConnectionHost}
      onPort={s.setConnectionPort}
      onPassword={s.setReplacementPassword}
      onSave={() => void s.saveConnection()}
    />
  );
}

function SettingsDraftForm({
  s,
  styles,
  connectionSection,
  removeHostButton,
}: {
  s: Settings;
  styles: Styles;
  connectionSection: ReactNode;
  removeHostButton: ReactNode;
}) {
  if (!s.draft) return null;
  return (
    <SettingsFormBody
      styles={styles}
      draft={s.draft}
      config={s.config}
      readOnly={s.readOnly}
      validationErrors={s.validationErrors}
      saving={s.saving}
      dirty={s.dirty}
      hasValidationErrors={Object.keys(s.validationErrors).length > 0}
      message={s.message}
      connectionSection={connectionSection}
      removeHostButton={removeHostButton}
      onIdentity={(identity) => s.set('identity', identity)}
      onPush={(push) => s.set('push', push)}
      onTriggers={(triggers) => s.set('triggers', triggers)}
      onLongJobSeconds={(longJobSeconds) => s.set('longJobSeconds', longJobSeconds)}
      onSession={(session) => s.set('session', session)}
      onAdmin={s.setAdmin}
      onTest={() => void s.sendTest()}
      onSave={() => void s.save()}
    />
  );
}

function healthKind(health: ServerSettingsProps['health']) {
  if (health === 'unauthorized') return 'unauthorized' as const;
  if (health === 'unreachable') return 'unreachable' as const;
  return 'loading' as const;
}

function SettingsContent({ p, s, styles, accent }: ContentProps) {
  const connectionSection = <HostConnection s={s} styles={styles} />;
  const removeHostButton = (
    <Button label="Remove this host" onPress={() => void s.removeHost()} tone="danger" />
  );
  if (p.health === 'unauthorized' || p.health === 'unreachable' || (s.loading && !s.draft)) {
    return (
      <HealthStatusBody
        styles={styles}
        accent={accent}
        connectionSection={connectionSection}
        removeHostButton={removeHostButton}
        kind={healthKind(p.health)}
        onUnauthorized={p.onUnauthorized}
        onRetry={p.onRetry}
      />
    );
  }
  if (s.draft) {
    return (
      <SettingsDraftForm
        s={s}
        styles={styles}
        connectionSection={connectionSection}
        removeHostButton={removeHostButton}
      />
    );
  }
  return (
    <SettingsUnavailable
      styles={styles}
      message={s.message?.text ?? 'Settings are unavailable.'}
      onRetry={p.onRetry}
    />
  );
}

function SettingsShell({
  p,
  s,
  styles,
  themeAccent,
  desktopUi,
}: {
  p: ServerSettingsProps;
  s: Settings;
  styles: Styles;
  themeAccent: string;
  desktopUi: boolean;
}) {
  return (
    <View
      style={[
        styles.backdrop,
        p.inline && desktopUi ? styles.inlineBackdrop : styles.mobileBackdrop,
      ]}
    >
      <View style={[styles.panel, p.inline && styles.inlinePanel]}>
        <SettingsHeader
          styles={styles}
          name={p.host?.name ?? 'Host settings'}
          subtitle={`${p.host ? `${p.host.host}:${p.host.port}` : 'Server'}${s.version ? ` · ${s.version}` : ''}`}
          accent={p.host?.color ?? themeAccent}
          closeLabel={p.inline ? 'Back to hosts' : 'Close server settings'}
          onClose={() => void s.close()}
        />
        <SettingsContent p={p} s={s} styles={styles} accent={themeAccent} />
        <AdminDialog
          styles={styles}
          admin={s.admin}
          currentPassword={s.currentPassword}
          nextPassword={s.nextPassword}
          confirmPassword={s.confirmPassword}
          adminBusy={s.adminBusy}
          onCurrentPassword={s.setCurrentPassword}
          onNextPassword={s.setNextPassword}
          onConfirmPassword={s.setConfirmPassword}
          onCancel={() => s.setAdmin(null)}
          onConfirm={() => void s.runAdmin()}
        />
      </View>
    </View>
  );
}

export function ServerSettings(p: ServerSettingsProps) {
  const { theme } = useAppTheme();
  const { width } = useWindowDimensions();
  const desktopUi = desktopLayout(isDesktop, width) === 'desktop';
  const styles = createStyles(theme.colors, desktopUi);
  const s = useServerSettings(p);
  if (p.inline && !p.visible) return null;
  const body = (
    <SettingsShell
      p={p}
      s={s}
      styles={styles}
      themeAccent={theme.colors.accent}
      desktopUi={desktopUi}
    />
  );
  if (p.inline) return body;
  return (
    <Modal
      visible={p.visible}
      animationType={desktopUi ? 'fade' : 'slide'}
      transparent={desktopUi}
      onRequestClose={() => void s.close()}
    >
      {body}
    </Modal>
  );
}
