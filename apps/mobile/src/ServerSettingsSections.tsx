import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Button,
  ColorSwatches,
  Field,
  Section,
  type ServerSettingsStyles,
  Toggle,
} from './ServerSettingsWidgets';
import { pushStatusHint, type ServerConfig, type ServerSettingsDraft } from './serverSettingsModel';

export type AdminOperation = 'password' | 'update' | 'restart' | null;
export type SettingsMessage = { kind: 'success' | 'error'; text: string };

export function ConnectionSection({
  styles,
  connectionHost,
  connectionPort,
  replacementPassword,
  connectionDirty,
  connectionOk,
  connectionReason,
  saving,
  onHost,
  onPort,
  onPassword,
  onSave,
}: {
  styles: ServerSettingsStyles;
  connectionHost: string;
  connectionPort: string;
  replacementPassword: string;
  connectionDirty: boolean;
  connectionOk: boolean;
  connectionReason?: string;
  saving: boolean;
  onHost: (value: string) => void;
  onPort: (value: string) => void;
  onPassword: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <Section title="Connection">
      <Field label="Address" value={connectionHost} onChangeText={onHost} />
      <Field label="Port" value={connectionPort} numeric onChangeText={onPort} />
      <Field
        label="Replace saved password"
        value={replacementPassword}
        secure
        onChangeText={onPassword}
      />
      {!connectionOk && <Text style={styles.error}>{connectionReason}</Text>}
      <Button
        label={connectionDirty ? 'Save connection' : 'Connection saved'}
        onPress={onSave}
        disabled={!connectionDirty || !connectionOk || saving}
      />
    </Section>
  );
}

export function IdentitySection({
  draft,
  readOnly,
  identityNameError,
  onChange,
}: {
  draft: ServerSettingsDraft;
  readOnly: boolean;
  identityNameError?: string;
  onChange: (identity: ServerSettingsDraft['identity']) => void;
}) {
  return (
    <Section title="Name & colour">
      <Field
        label="Name"
        hint="Shown on every client and used in notifications."
        value={draft.identity.name}
        editable={!readOnly}
        error={identityNameError}
        onChangeText={(name) => onChange({ ...draft.identity, name })}
      />
      <ColorSwatches
        value={draft.identity.color}
        disabled={readOnly}
        onChange={(color) => onChange({ ...draft.identity, color })}
      />
    </Section>
  );
}

export function NotificationsSection({
  styles,
  draft,
  readOnly,
  pushDevices,
  longJobError,
  onPush,
  onTriggers,
  onLongJobSeconds,
  onTest,
}: {
  styles: ServerSettingsStyles;
  draft: ServerSettingsDraft;
  readOnly: boolean;
  pushDevices: number;
  longJobError?: string;
  onPush: (push: ServerSettingsDraft['push']) => void;
  onTriggers: (triggers: ServerSettingsDraft['triggers']) => void;
  onLongJobSeconds: (value: string) => void;
  onTest: () => void;
}) {
  return (
    <Section title="Notifications">
      <Toggle
        label="Push to my devices"
        value={draft.push.enabled}
        disabled={readOnly}
        onValueChange={(enabled) => onPush({ ...draft.push, enabled })}
      />
      <Text style={styles.hint}>
        {pushStatusHint(draft.push.enabled, pushDevices, Platform.OS === 'ios')}
      </Text>
      <Toggle
        label="Agent needs input"
        value={draft.triggers.waiting}
        disabled={readOnly}
        onValueChange={(waiting) => onTriggers({ ...draft.triggers, waiting })}
      />
      <Toggle
        label="Alerts from programs"
        value={draft.triggers.oscNotify}
        disabled={readOnly}
        onValueChange={(oscNotify) => onTriggers({ ...draft.triggers, oscNotify })}
      />
      <Toggle
        label="Session ends"
        value={draft.triggers.exit}
        disabled={readOnly}
        onValueChange={(exit) => onTriggers({ ...draft.triggers, exit })}
      />
      <Toggle
        label="Long command finishes"
        value={draft.triggers.longJob}
        disabled={readOnly}
        onValueChange={(longJob) => onTriggers({ ...draft.triggers, longJob })}
      />
      <Field
        label="Count a command as long after"
        value={draft.longJobSeconds}
        editable={!readOnly}
        numeric
        error={longJobError}
        onChangeText={onLongJobSeconds}
      />
      <Button label="Send test notification" onPress={onTest} disabled={readOnly || !pushDevices} />
    </Section>
  );
}

export function SessionsSection({
  styles,
  draft,
  readOnly,
  errors,
  onChange,
}: {
  styles: ServerSettingsStyles;
  draft: ServerSettingsDraft;
  readOnly: boolean;
  errors: { scrollbackRows?: string; silenceMs?: string };
  onChange: (session: ServerSettingsDraft['session']) => void;
}) {
  return (
    <Section title="Sessions">
      <Text style={styles.hint}>Changes apply to newly started sessions.</Text>
      <Field
        label="Default shell"
        value={draft.session.defaultShell}
        editable={!readOnly}
        onChangeText={(defaultShell) => onChange({ ...draft.session, defaultShell })}
      />
      <Field
        label="Default directory"
        value={draft.session.defaultCwd}
        editable={!readOnly}
        onChangeText={(defaultCwd) => onChange({ ...draft.session, defaultCwd })}
      />
      <Field
        label="Scrollback rows"
        value={draft.session.scrollbackRows}
        editable={!readOnly}
        numeric
        error={errors.scrollbackRows}
        onChangeText={(scrollbackRows) => onChange({ ...draft.session, scrollbackRows })}
      />
      <Field
        label="Mark a session idle after"
        value={draft.session.silenceMs}
        editable={!readOnly}
        numeric
        error={errors.silenceMs}
        onChangeText={(silenceMs) => onChange({ ...draft.session, silenceMs })}
      />
    </Section>
  );
}

export function MaintenanceSection({
  styles,
  removeHostButton,
  onAdmin,
}: {
  styles: ServerSettingsStyles;
  removeHostButton: React.ReactNode;
  onAdmin: (admin: Exclude<AdminOperation, null>) => void;
}) {
  return (
    <View style={styles.maintenance}>
      <View style={styles.divider} />
      <Section title="Maintenance" subdued>
        <Text style={styles.hint}>
          Restart and update keep holder-backed sessions alive; they reconnect after the daemon
          returns.
        </Text>
        <Button label="Change password" onPress={() => onAdmin('password')} tone="danger" />
        <Button label="Check for update" onPress={() => onAdmin('update')} tone="danger" />
        <Button label="Restart server" onPress={() => onAdmin('restart')} tone="danger" />
        {removeHostButton}
      </Section>
    </View>
  );
}

export function HealthStatusBody({
  styles,
  accent,
  connectionSection,
  removeHostButton,
  kind,
  onUnauthorized,
  onRetry,
}: {
  styles: ServerSettingsStyles;
  accent: string;
  connectionSection: React.ReactNode;
  removeHostButton: React.ReactNode;
  kind: 'unauthorized' | 'unreachable' | 'loading';
  onUnauthorized: () => void;
  onRetry: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      {connectionSection}
      <View style={styles.state}>
        {kind === 'loading' ? (
          <ActivityIndicator color={accent} />
        ) : kind === 'unauthorized' ? (
          <>
            <Text style={styles.error}>This host needs its password again.</Text>
            <Button label="Enter password" onPress={onUnauthorized} />
          </>
        ) : (
          <>
            <Text style={styles.error}>Host unreachable. Last-known settings are read-only.</Text>
            <Button label="Retry" onPress={onRetry} />
          </>
        )}
      </View>
      {kind !== 'loading' && (
        <View style={styles.maintenance}>
          <View style={styles.divider} />
          {removeHostButton}
        </View>
      )}
    </ScrollView>
  );
}

export function SettingsFormBody({
  styles,
  draft,
  config,
  readOnly,
  validationErrors,
  saving,
  dirty,
  hasValidationErrors,
  message,
  connectionSection,
  removeHostButton,
  onIdentity,
  onPush,
  onTriggers,
  onLongJobSeconds,
  onSession,
  onAdmin,
  onTest,
  onSave,
}: {
  styles: ServerSettingsStyles;
  draft: ServerSettingsDraft;
  config: ServerConfig | null;
  readOnly: boolean;
  validationErrors: ReturnType<typeof import('./serverSettingsModel').validateServerSettingsDraft>;
  saving: boolean;
  dirty: boolean;
  hasValidationErrors: boolean;
  message: SettingsMessage | null;
  connectionSection: React.ReactNode;
  removeHostButton: React.ReactNode;
  onIdentity: (identity: ServerSettingsDraft['identity']) => void;
  onPush: (push: ServerSettingsDraft['push']) => void;
  onTriggers: (triggers: ServerSettingsDraft['triggers']) => void;
  onLongJobSeconds: (value: string) => void;
  onSession: (session: ServerSettingsDraft['session']) => void;
  onAdmin: (admin: Exclude<AdminOperation, null>) => void;
  onTest: () => void;
  onSave: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      {connectionSection}
      <IdentitySection
        draft={draft}
        readOnly={readOnly}
        identityNameError={validationErrors.identityName}
        onChange={onIdentity}
      />
      <NotificationsSection
        styles={styles}
        draft={draft}
        readOnly={readOnly}
        pushDevices={config?.pushDevices ?? 0}
        longJobError={validationErrors.longJobSeconds}
        onPush={onPush}
        onTriggers={onTriggers}
        onLongJobSeconds={onLongJobSeconds}
        onTest={onTest}
      />
      <SessionsSection
        styles={styles}
        draft={draft}
        readOnly={readOnly}
        errors={{
          scrollbackRows: validationErrors.scrollbackRows,
          silenceMs: validationErrors.silenceMs,
        }}
        onChange={onSession}
      />
      <MaintenanceSection styles={styles} removeHostButton={removeHostButton} onAdmin={onAdmin} />
      {message && (
        <Text
          testID={`server-settings-message-${message.kind}`}
          style={message.kind === 'error' ? styles.error : styles.message}
        >
          {message.text}
        </Text>
      )}
      <Button
        label={saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        onPress={onSave}
        disabled={readOnly || saving || !dirty || hasValidationErrors}
      />
    </ScrollView>
  );
}

export function AdminDialog({
  styles,
  admin,
  currentPassword,
  nextPassword,
  confirmPassword,
  adminBusy,
  onCurrentPassword,
  onNextPassword,
  onConfirmPassword,
  onCancel,
  onConfirm,
}: {
  styles: ServerSettingsStyles;
  admin: AdminOperation;
  currentPassword: string;
  nextPassword: string;
  confirmPassword: string;
  adminBusy: boolean;
  onCurrentPassword: (value: string) => void;
  onNextPassword: (value: string) => void;
  onConfirmPassword: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal visible={admin !== null} transparent animationType="fade" onRequestClose={onCancel}>
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
            onChangeText={onCurrentPassword}
          />
          {admin === 'password' && (
            <>
              <Field
                label="New password"
                value={nextPassword}
                secure
                onChangeText={onNextPassword}
              />
              <Field
                label="Confirm new password"
                value={confirmPassword}
                secure
                onChangeText={onConfirmPassword}
              />
            </>
          )}
          <View style={styles.row}>
            <Button label="Cancel" onPress={onCancel} />
            <Button
              label={adminBusy ? 'Working…' : 'Confirm'}
              onPress={onConfirm}
              disabled={adminBusy}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function SettingsUnavailable({
  styles,
  message,
  onRetry,
}: {
  styles: ServerSettingsStyles;
  message: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.state}>
      <Text style={styles.error}>{message}</Text>
      <Button label="Retry" onPress={onRetry} />
    </View>
  );
}

export function SettingsHeader({
  styles,
  name,
  subtitle,
  accent,
  closeLabel,
  onClose,
}: {
  styles: ServerSettingsStyles;
  name: string;
  subtitle: string;
  accent: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <View style={[styles.header, { borderLeftColor: accent }]}>
      <View>
        <Text style={styles.title}>{name}</Text>
        <Text style={styles.subTitle}>{subtitle}</Text>
      </View>
      <TouchableOpacity
        style={styles.closeButton}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
      >
        <Text style={styles.action}>Close</Text>
      </TouchableOpacity>
    </View>
  );
}
