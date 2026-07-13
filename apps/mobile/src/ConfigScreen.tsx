import { KeyboardAvoidingView, View, Text, TextInput, TouchableOpacity, Platform, StyleSheet } from 'react-native';
import TitleBar from './TitleBar';
import { isDesktop, isMacDesktop } from './platform';
import { styles as shared, MONO } from './styles';

export type SetupMode = 'unknown' | 'create' | 'enter';
export type TestStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; msg: string };

// First-run / connection settings screen. State lives in the parent; this is the
// presentational form. On desktop it renders a minimal TitleBar so the frameless
// window still has drag + window controls before any session exists.
export function ConfigScreen({
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
}: {
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
}) {
  return (
    <>
      {/* Desktop: frameless window still needs drag + close/min/max here too. */}
      {isDesktop && <TitleBar isMac={isMacDesktop} title="Tether" />}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.configContainer}
      >
        <View style={styles.configInner}>
          <View style={styles.configLogoContainer}>
            <View style={styles.configIconBox}>
              <Text style={styles.configLogoIcon}>{'>_'}</Text>
            </View>
            <Text style={styles.configTitle}>{isDesktop ? 'Tether Desktop' : 'Tether Mobile'}</Text>
            <Text style={styles.configSubtitle}>Connect to a terminal on your server</Text>
          </View>

          <View style={styles.formContainer}>
            <Text style={styles.inputLabel}>Server IP / Host</Text>
            <TextInput
              style={styles.configInput}
              value={serverIp}
              onChangeText={(t) => {
                setServerIp(t);
                setSetupMode('unknown');
                setTestStatus({ kind: 'idle' });
              }}
              placeholder="e.g. 192.168.50.30"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.inputLabel}>Port</Text>
            <TextInput
              style={styles.configInput}
              value={port}
              onChangeText={(t) => {
                setPort(t);
                setSetupMode('unknown');
                setTestStatus({ kind: 'idle' });
              }}
              placeholder="e.g. 8085"
              placeholderTextColor="#64748b"
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
              placeholderTextColor="#64748b"
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
                  placeholderTextColor="#64748b"
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
              The password controls access. For traffic encryption, run tether behind a tunnel
              (Tailscale, WireGuard, or SSH).
            </Text>

            {testStatus.kind === 'error' && <Text style={styles.testError}>{testStatus.msg}</Text>}
            {testStatus.kind === 'ok' && (
              <View style={styles.testOkRow}>
                <View style={[shared.badgeDot, shared.dotConnected]} />
                <Text style={styles.testOk}>Reachable</Text>
              </View>
            )}

            {testStatus.kind === 'ok' ? (
              <TouchableOpacity style={styles.connectBtn} onPress={onSave}>
                <Text style={styles.connectBtnText}>Save &amp; Connect</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.connectBtn}
                onPress={onTest}
                disabled={testStatus.kind === 'testing'}
              >
                <Text style={styles.connectBtnText}>
                  {testStatus.kind === 'testing'
                    ? 'Testing…'
                    : setupMode === 'create'
                      ? 'Create password'
                      : 'Test connection'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  configContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#070a13',
  },
  // Caps the login form width so it doesn't stretch across a wide desktop window.
  configInner: {
    width: '100%',
    maxWidth: 400,
  },
  configLogoContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  configIconBox: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.2)',
    marginBottom: 16,
  },
  configLogoIcon: {
    fontSize: 32,
    fontFamily: MONO,
    fontWeight: 'bold',
    color: '#818cf8',
  },
  configTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 8,
  },
  configSubtitle: {
    fontSize: 12,
    color: '#94a3b8',
    textAlign: 'center',
  },
  formContainer: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: 20,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#94a3b8',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  configInput: {
    backgroundColor: '#030712',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    color: '#e2e8f0',
    fontSize: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 16,
    fontFamily: MONO,
  },
  connectBtn: {
    backgroundColor: '#3730a3',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  connectBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  configHint: { color: '#64748b', fontSize: 12, lineHeight: 17, marginTop: 4, marginBottom: 12 },
  testError: { color: '#f87171', fontSize: 13, marginBottom: 10 },
  testOkRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
  testOk: { color: '#4ade80', fontSize: 13 },
});
