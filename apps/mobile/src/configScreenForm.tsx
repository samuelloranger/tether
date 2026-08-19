import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { AppTheme } from './appTheme';
import type { SetupMode, TestStatus } from './ConfigScreen';
import type { ConfigStyles } from './configScreenStyles';
import { isDesktop } from './platform';
import type { createStyles } from './styles';
import type { HostProfile } from './tether/hostStore';

type SharedStyles = ReturnType<typeof createStyles>;

export function ConfigConnectionForm({
  styles,
  shared,
  theme,
  serverIp,
  setServerIp,
  port,
  setPort,
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
  setupMode,
  setSetupMode,
  testStatus,
  setTestStatus,
  onSave,
  onTest,
  hosts,
  onManageHosts,
}: {
  styles: ConfigStyles;
  shared: SharedStyles;
  theme: AppTheme;
  serverIp: string;
  setServerIp: (t: string) => void;
  port: string;
  setPort: (t: string) => void;
  password: string;
  setPassword: (t: string) => void;
  confirmPassword: string;
  setConfirmPassword: (t: string) => void;
  setupMode: SetupMode;
  setSetupMode: (m: SetupMode) => void;
  testStatus: TestStatus;
  setTestStatus: (s: TestStatus) => void;
  onSave: () => void;
  onTest: () => void;
  hosts?: HostProfile[] | null;
  onManageHosts: () => void;
}) {
  const resetSetup = () => {
    setSetupMode('unknown');
    setTestStatus({ kind: 'idle' });
  };
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.configContainer}
    >
      <View style={styles.configInner}>
        <View style={styles.configBrandRow}>
          <Text style={styles.configTitle}>Tether</Text>
          <Text style={styles.configModeTag}>{isDesktop ? 'Desktop' : 'Client'}</Text>
        </View>
        <View style={styles.configRule} />
        <Text style={styles.configSubtitle}>Connect to a terminal on your server</Text>
        {hosts && hosts.length > 0 && (
          <TouchableOpacity
            onPress={onManageHosts}
            accessibilityRole="button"
            accessibilityLabel="Manage hosts"
            style={styles.manageHosts}
          >
            <Text style={{ color: theme.colors.accent }}>Manage hosts</Text>
          </TouchableOpacity>
        )}
        <ConfigFields
          styles={styles}
          theme={theme}
          serverIp={serverIp}
          setServerIp={setServerIp}
          port={port}
          setPort={setPort}
          password={password}
          setPassword={setPassword}
          confirmPassword={confirmPassword}
          setConfirmPassword={setConfirmPassword}
          setupMode={setupMode}
          testStatus={testStatus}
          setTestStatus={setTestStatus}
          resetSetup={resetSetup}
        />
        <ConfigTestActions
          styles={styles}
          shared={shared}
          theme={theme}
          setupMode={setupMode}
          testStatus={testStatus}
          onSave={onSave}
          onTest={onTest}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function ConfigFields({
  styles,
  theme,
  serverIp,
  setServerIp,
  port,
  setPort,
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
  setupMode,
  testStatus,
  setTestStatus,
  resetSetup,
}: {
  styles: ConfigStyles;
  theme: AppTheme;
  serverIp: string;
  setServerIp: (t: string) => void;
  port: string;
  setPort: (t: string) => void;
  password: string;
  setPassword: (t: string) => void;
  confirmPassword: string;
  setConfirmPassword: (t: string) => void;
  setupMode: SetupMode;
  testStatus: TestStatus;
  setTestStatus: (s: TestStatus) => void;
  resetSetup: () => void;
}) {
  const faint = theme.colors.textFaint;
  return (
    <View style={styles.formContainer}>
      <Text style={styles.inputLabel}>Server</Text>
      <TextInput
        style={styles.configInput}
        value={serverIp}
        onChangeText={(t) => {
          setServerIp(t);
          resetSetup();
        }}
        placeholder="e.g. 192.168.50.30"
        accessibilityLabel="Server IP or host"
        placeholderTextColor={faint}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.inputLabel}>Port</Text>
      <TextInput
        style={styles.configInput}
        value={port}
        onChangeText={(t) => {
          setPort(t);
          resetSetup();
        }}
        placeholder="e.g. 8085"
        accessibilityLabel="Port"
        placeholderTextColor={faint}
        keyboardType="numeric"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.inputLabel}>Password</Text>
      <TextInput
        style={styles.configInput}
        value={password}
        onChangeText={(t) => {
          setPassword(t);
          setTestStatus({ kind: 'idle' });
        }}
        placeholder={setupMode === 'create' ? 'Choose a password' : 'Shared server password'}
        accessibilityLabel="Password"
        placeholderTextColor={faint}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      {setupMode === 'create' && (
        <>
          <TextInput
            style={styles.configInput}
            value={confirmPassword}
            onChangeText={(t) => {
              setConfirmPassword(t);
              setTestStatus({ kind: 'idle' });
            }}
            placeholder="Confirm password"
            accessibilityLabel="Confirm password"
            placeholderTextColor={faint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.configHint}>
            This server has no password yet. The one you choose here will be required by every
            client.
          </Text>
        </>
      )}
      <Text style={styles.configHint}>
        The password controls access. For traffic encryption, run tether behind a tunnel (Tailscale,
        WireGuard, or SSH).
      </Text>
      {testStatus.kind === 'error' && <Text style={styles.testError}>{testStatus.msg}</Text>}
    </View>
  );
}

function ConfigTestActions({
  styles,
  shared,
  theme,
  setupMode,
  testStatus,
  onSave,
  onTest,
}: {
  styles: ConfigStyles;
  shared: SharedStyles;
  theme: AppTheme;
  setupMode: SetupMode;
  testStatus: TestStatus;
  onSave: () => void;
  onTest: () => void;
}) {
  return (
    <>
      {testStatus.kind === 'ok' && (
        <View style={styles.testOkRow}>
          <View style={[shared.badgeDot, shared.dotConnected]} />
          <Text style={styles.testOk}>Reachable</Text>
        </View>
      )}
      {testStatus.kind === 'ok' ? (
        <TouchableOpacity
          style={styles.connectBtn}
          onPress={onSave}
          accessibilityRole="button"
          accessibilityLabel="Save and connect"
        >
          <Text style={styles.connectBtnText}>Save &amp; Connect</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.connectBtn, testStatus.kind === 'testing' && styles.connectBtnDisabled]}
          onPress={onTest}
          disabled={testStatus.kind === 'testing'}
          accessibilityRole="button"
          accessibilityLabel={setupMode === 'create' ? 'Create password' : 'Test connection'}
          accessibilityState={{ disabled: testStatus.kind === 'testing' }}
        >
          {testStatus.kind === 'testing' && (
            <ActivityIndicator size="small" color={theme.colors.accentText} />
          )}
          <Text style={styles.connectBtnText}>
            {testStatus.kind === 'testing'
              ? 'Testing…'
              : setupMode === 'create'
                ? 'Create password'
                : 'Test connection'}
          </Text>
        </TouchableOpacity>
      )}
    </>
  );
}
