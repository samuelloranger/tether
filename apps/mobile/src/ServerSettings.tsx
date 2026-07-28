import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { confirmAction } from './dialog';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import { isDesktop } from './platform';
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

type AdminOperation = 'password' | 'update' | 'restart' | null;

export function ServerSettings({
  visible,
  host,
  client,
  health,
  onClose,
  onRetry,
  onUnauthorized,
  onIdentitySaved,
  onPasswordChanged,
}: {
  visible: boolean;
  host: HostProfile | null;
  client: HostClient | null;
  health: HostHealthStatus;
  onClose: () => void;
  onRetry: () => void;
  onUnauthorized: () => void;
  onIdentitySaved: (identity: ServerConfig['identity']) => void;
  onPasswordChanged: (password: string) => Promise<void>;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [draft, setDraft] = useState<ServerSettingsDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [admin, setAdmin] = useState<AdminOperation>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !client || health === 'unreachable') return;
    if (health === 'unauthorized') return;
    setLoading(true);
    setMessage(null);
    void Promise.all([loadServerConfig(client), loadServerVersion(client)])
      .then(([nextConfig, nextVersion]) => {
        setConfig(nextConfig);
        setDraft(createServerSettingsDraft(nextConfig));
        setVersion(nextVersion);
      })
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : 'Could not load settings.'),
      )
      .finally(() => setLoading(false));
  }, [client, health, visible]);

  const dirty = useMemo(
    () => !!config && !!draft && isServerSettingsDirty(config, draft),
    [config, draft],
  );
  const readOnly = health === 'unreachable' || !draft;
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
    const errors = validateServerSettingsDraft(draft);
    if (Object.keys(errors).length)
      return setMessage(Object.values(errors)[0] ?? 'Check your settings.');
    setSaving(true);
    setMessage(null);
    try {
      const next = await patchServerConfig(client, patchForDraft(config, draft));
      setConfig(next);
      setDraft(createServerSettingsDraft(next));
      onIdentitySaved(next.identity);
      setMessage('Saved. Session defaults apply to newly started sessions.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };
  const sendTest = async () => {
    if (!config || !draft || !client) return;
    setMessage(null);
    try {
      await sendServerNotificationTest(client, patchForDraft(config, draft));
      setMessage('Test notification sent.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Test notification failed.');
    }
  };
  const runAdmin = async () => {
    if (!client || !admin || !currentPassword) return;
    if (admin === 'password' && (!nextPassword || nextPassword !== confirmPassword)) {
      setMessage('New passwords must match.');
      return;
    }
    setAdminBusy(true);
    setMessage(null);
    try {
      if (admin === 'password') {
        await changeServerPassword(client, currentPassword, nextPassword);
        await onPasswordChanged(nextPassword);
        setMessage('Password changed. Existing token sessions remain connected.');
      } else if (admin === 'update') {
        setMessage('Updating… Sessions survive the restart and will reconnect.');
        await updateServer(client, currentPassword);
        onRetry();
        let actual: string | null = null;
        for (let attempt = 0; attempt < 10 && !actual; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          actual = await loadServerVersion(client).catch(() => null);
        }
        setVersion(actual);
        setMessage(
          actual
            ? `Updated. Server is now ${actual}.`
            : 'Update requested; waiting for server reconnect.',
        );
      } else {
        setMessage('Restarting… Sessions survive and will reconnect.');
        await restartServer(client, currentPassword);
        onRetry();
      }
      setAdmin(null);
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Server operation failed.');
    } finally {
      setAdminBusy(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType={isDesktop ? 'fade' : 'slide'}
      transparent={isDesktop}
      onRequestClose={() => void close()}
    >
      <View style={[styles.backdrop, !isDesktop && styles.mobileBackdrop]}>
        <View style={styles.panel}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Server settings</Text>
              <Text style={styles.subTitle}>
                {host?.name ?? 'Server'}
                {version ? ` · ${version}` : ''}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => void close()}
              accessibilityRole="button"
              accessibilityLabel="Close server settings"
            >
              <Text style={styles.action}>Close</Text>
            </TouchableOpacity>
          </View>
          {health === 'unauthorized' ? (
            <View style={styles.state}>
              <Text style={styles.error}>This host needs its password again.</Text>
              <Button label="Enter password" onPress={onUnauthorized} />
            </View>
          ) : health === 'unreachable' ? (
            <View style={styles.state}>
              <Text style={styles.error}>Host unreachable. Last-known settings are read-only.</Text>
              <Button label="Retry" onPress={onRetry} />
            </View>
          ) : loading && !draft ? (
            <View style={styles.state}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : draft ? (
            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
              <Section title="Identity">
                <Field
                  label="Name"
                  value={draft.identity.name}
                  editable={!readOnly}
                  onChangeText={(name) => set('identity', { ...draft.identity, name })}
                />
                <Field
                  label="Color"
                  value={draft.identity.color}
                  editable={!readOnly}
                  onChangeText={(color) => set('identity', { ...draft.identity, color })}
                />
              </Section>
              <Section title="Notifications">
                <Toggle
                  label="Enabled"
                  value={draft.notify.enabled}
                  disabled={readOnly}
                  onValueChange={(enabled) => set('notify', { ...draft.notify, enabled })}
                />
                <Field
                  label="ntfy URL"
                  value={draft.notify.url}
                  editable={!readOnly}
                  onChangeText={(url) => set('notify', { ...draft.notify, url })}
                />
                <Field
                  label="Topic"
                  value={draft.notify.topic}
                  editable={!readOnly}
                  onChangeText={(topic) => set('notify', { ...draft.notify, topic })}
                />
                {draft.notify.token === undefined ? (
                  <Button
                    label={draft.notify.hasToken ? 'Token set · Replace' : 'Set token'}
                    onPress={() => set('notify', { ...draft.notify, token: '' })}
                    disabled={readOnly}
                  />
                ) : (
                  <Field
                    label="Replacement token"
                    value={draft.notify.token}
                    secure
                    editable={!readOnly}
                    onChangeText={(token) => set('notify', { ...draft.notify, token })}
                  />
                )}
                <Toggle
                  label="Waiting"
                  value={draft.triggers.waiting}
                  disabled={readOnly}
                  onValueChange={(waiting) => set('triggers', { ...draft.triggers, waiting })}
                />
                <Toggle
                  label="OSC notify"
                  value={draft.triggers.oscNotify}
                  disabled={readOnly}
                  onValueChange={(oscNotify) => set('triggers', { ...draft.triggers, oscNotify })}
                />
                <Toggle
                  label="Exit"
                  value={draft.triggers.exit}
                  disabled={readOnly}
                  onValueChange={(exit) => set('triggers', { ...draft.triggers, exit })}
                />
                <Toggle
                  label="Long job"
                  value={draft.triggers.longJob}
                  disabled={readOnly}
                  onValueChange={(longJob) => set('triggers', { ...draft.triggers, longJob })}
                />
                <Field
                  label="Long job seconds"
                  value={String(draft.longJobSeconds)}
                  editable={!readOnly}
                  numeric
                  onChangeText={(value) => set('longJobSeconds', Number(value))}
                />
                <Button label="Send test" onPress={() => void sendTest()} disabled={readOnly} />
              </Section>
              <Section title="Session defaults">
                <Text style={styles.hint}>Changes apply to newly started sessions.</Text>
                <Field
                  label="Default shell"
                  value={draft.session.defaultShell}
                  editable={!readOnly}
                  onChangeText={(defaultShell) =>
                    set('session', { ...draft.session, defaultShell })
                  }
                />
                <Field
                  label="Default directory"
                  value={draft.session.defaultCwd}
                  editable={!readOnly}
                  onChangeText={(defaultCwd) => set('session', { ...draft.session, defaultCwd })}
                />
                <Field
                  label="Scrollback rows"
                  value={String(draft.session.scrollbackRows)}
                  editable={!readOnly}
                  numeric
                  onChangeText={(value) =>
                    set('session', { ...draft.session, scrollbackRows: Number(value) })
                  }
                />
                <Field
                  label="Silence threshold (ms)"
                  value={String(draft.session.silenceMs)}
                  editable={!readOnly}
                  numeric
                  onChangeText={(value) =>
                    set('session', { ...draft.session, silenceMs: Number(value) })
                  }
                />
              </Section>
              <Section title="Server ops">
                <Text style={styles.hint}>
                  Restart and update keep holder-backed sessions alive; they reconnect after the
                  daemon returns.
                </Text>
                <Button label="Change password" onPress={() => setAdmin('password')} />
                <Button label="Check for update" onPress={() => setAdmin('update')} />
                <Button label="Restart server" onPress={() => setAdmin('restart')} />
              </Section>
              {message && (
                <Text
                  style={
                    message.includes('failed') || message.includes('Could not')
                      ? styles.error
                      : styles.message
                  }
                >
                  {message}
                </Text>
              )}
              <Button
                label={saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
                onPress={() => void save()}
                disabled={readOnly || saving || !dirty}
              />
            </ScrollView>
          ) : (
            <View style={styles.state}>
              <Text style={styles.error}>{message ?? 'Settings are unavailable.'}</Text>
              <Button label="Retry" onPress={onRetry} />
            </View>
          )}
          <Modal
            visible={admin !== null}
            transparent
            animationType="fade"
            onRequestClose={() => setAdmin(null)}
          >
            <View style={styles.backdrop}>
              <View style={styles.dialog}>
                <Text style={styles.title}>
                  {admin === 'password'
                    ? 'Change password'
                    : admin === 'update'
                      ? 'Update server'
                      : 'Restart server'}
                </Text>
                <Field
                  label="Current password"
                  value={currentPassword}
                  secure
                  onChangeText={setCurrentPassword}
                />
                {admin === 'password' && (
                  <>
                    <Field
                      label="New password"
                      value={nextPassword}
                      secure
                      onChangeText={setNextPassword}
                    />
                    <Field
                      label="Confirm new password"
                      value={confirmPassword}
                      secure
                      onChangeText={setConfirmPassword}
                    />
                  </>
                )}
                <View style={styles.row}>
                  <Button label="Cancel" onPress={() => setAdmin(null)} />
                  <Button
                    label={adminBusy ? 'Working…' : 'Confirm'}
                    onPress={() => void runAdmin()}
                    disabled={adminBusy}
                  />
                </View>
              </View>
            </View>
          </Modal>
        </View>
      </View>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { theme } = useAppTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: '700' }}>{title}</Text>
      {children}
    </View>
  );
}
function Field({
  label,
  secure,
  numeric,
  ...props
}: {
  label: string;
  value: string;
  editable?: boolean;
  secure?: boolean;
  numeric?: boolean;
  onChangeText: (value: string) => void;
}) {
  const { theme } = useAppTheme();
  return (
    <View>
      <Text style={{ color: theme.colors.textMuted, fontSize: 11, marginBottom: 4 }}>{label}</Text>
      <TextInput
        {...props}
        secureTextEntry={secure}
        keyboardType={numeric ? 'numeric' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={theme.colors.textFaint}
        style={{
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          padding: 10,
          color: theme.colors.text,
          backgroundColor: theme.colors.input,
        }}
      />
    </View>
  );
}
function Toggle({
  label,
  value,
  disabled,
  onValueChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ color: theme.colors.text }}>{label}</Text>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ true: theme.colors.accent }}
      />
    </View>
  );
}
function Button({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { theme } = useAppTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: MIN_TOUCH_TARGET,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 8,
        paddingHorizontal: 12,
        backgroundColor: theme.colors.accent,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <Text style={{ color: theme.colors.accentText, fontWeight: '700' }}>{label}</Text>
    </TouchableOpacity>
  );
}
function createStyles(c: AppColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: c.overlay,
      justifyContent: 'center',
      alignItems: 'center',
    },
    mobileBackdrop: { backgroundColor: c.background },
    panel: {
      width: isDesktop ? 580 : '100%',
      maxHeight: '100%',
      flex: isDesktop ? 0 : 1,
      backgroundColor: c.background,
      borderRadius: isDesktop ? SURFACE_RADIUS.panel : 0,
      overflow: 'hidden',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 18,
      borderBottomWidth: 1,
      borderColor: c.border,
    },
    title: { color: c.text, fontSize: 18, fontWeight: '700' },
    subTitle: { color: c.textMuted, fontSize: 12, marginTop: 3 },
    action: { color: c.accent, fontWeight: '700' },
    body: { padding: 18, gap: 24 },
    state: { flex: 1, padding: 24, gap: 16, justifyContent: 'center' },
    hint: { color: c.textMuted, fontSize: 12, lineHeight: 17 },
    message: { color: c.success, fontSize: 13 },
    error: { color: c.danger, fontSize: 13 },
    dialog: {
      width: 360,
      maxWidth: '90%',
      gap: 12,
      padding: 20,
      borderRadius: SURFACE_RADIUS.panel,
      backgroundColor: c.surface,
    },
    row: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  });
}
