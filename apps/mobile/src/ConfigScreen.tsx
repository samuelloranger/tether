import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { HostsScreen } from './HostsScreen';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import { isDesktop, isMacDesktop } from './platform';
import { createStyles, MONO } from './styles';
import TitleBar from './TitleBar';
import type { HostProfile } from './tether/hostStore';

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
  hosts,
  storeError,
  onRetryHosts,
  onAddHost,
  onEditHost,
  onRemoveHost,
  onUpdateHost,
  onReorderHosts,
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
  hosts?: HostProfile[] | null;
  storeError?: string | null;
  onRetryHosts?: () => void;
  onAddHost?: () => void;
  onEditHost?: (hostId: string) => void;
  onRemoveHost?: (hostId: string) => void;
  onUpdateHost?: (hostId: string, changes: Partial<Omit<HostProfile, 'id' | 'order'>>) => void;
  onReorderHosts?: (ids: string[]) => void;
}) {
  const { theme } = useAppTheme();
  const shared = createStyles(theme.colors);
  const styles = createConfigStyles(theme.colors);
  const [hostsOpen, setHostsOpen] = useState(false);
  if (storeError) {
    return (
      <View style={styles.configContainer}>
        <Text style={styles.configTitle}>Hosts unavailable</Text>
        <Text style={styles.testError}>{storeError}</Text>
        <TouchableOpacity
          style={styles.connectBtn}
          onPress={onRetryHosts}
          accessibilityRole="button"
          accessibilityLabel="Retry loading hosts"
        >
          <Text style={styles.connectBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (
    hostsOpen &&
    hosts &&
    onAddHost &&
    onEditHost &&
    onRemoveHost &&
    onUpdateHost &&
    onReorderHosts
  ) {
    return (
      <HostsScreen
        hosts={hosts}
        onBack={() => setHostsOpen(false)}
        onAdd={() => {
          setHostsOpen(false);
          onAddHost();
        }}
        onEdit={(id) => {
          setHostsOpen(false);
          onEditHost(id);
        }}
        onRemove={onRemoveHost}
        onUpdate={onUpdateHost}
        onReorder={onReorderHosts}
      />
    );
  }
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
            {hosts && hosts.length > 0 && (
              <TouchableOpacity
                onPress={() => setHostsOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Manage hosts"
              >
                <Text style={{ color: theme.colors.accent, marginTop: 12 }}>Manage hosts</Text>
              </TouchableOpacity>
            )}
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
              placeholderTextColor={theme.colors.textFaint}
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
              placeholderTextColor={theme.colors.textFaint}
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
              placeholderTextColor={theme.colors.textFaint}
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
                  placeholderTextColor={theme.colors.textFaint}
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
                style={[
                  styles.connectBtn,
                  testStatus.kind === 'testing' && styles.connectBtnDisabled,
                ]}
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
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const createConfigStyles = (c: AppColors) =>
  StyleSheet.create({
    configContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 24,
      backgroundColor: c.background,
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
      borderRadius: SURFACE_RADIUS.hero,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.accent,
      marginBottom: 16,
    },
    configLogoIcon: {
      fontSize: 32,
      fontFamily: MONO,
      fontWeight: 'bold',
      color: c.accent,
    },
    configTitle: {
      fontSize: 24,
      fontWeight: 'bold',
      color: c.text,
      marginBottom: 8,
    },
    configSubtitle: {
      fontSize: 12,
      color: c.textMuted,
      textAlign: 'center',
    },
    formContainer: {
      backgroundColor: c.surface,
      borderRadius: SURFACE_RADIUS.hero,
      borderWidth: 1,
      borderColor: c.border,
      padding: 20,
    },
    inputLabel: {
      fontSize: 11,
      fontWeight: '700',
      textTransform: 'uppercase',
      color: c.textMuted,
      marginBottom: 6,
      letterSpacing: 0.5,
    },
    configInput: {
      backgroundColor: c.input,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: SURFACE_RADIUS.control,
      color: c.text,
      fontSize: 14,
      paddingVertical: 10,
      paddingHorizontal: 12,
      marginBottom: 16,
      fontFamily: MONO,
    },
    connectBtn: {
      backgroundColor: c.accent,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: 16,
      borderRadius: SURFACE_RADIUS.control,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 8,
      marginTop: 10,
    },
    connectBtnDisabled: { opacity: 0.65 },
    connectBtnText: {
      color: c.accentText,
      fontSize: 14,
      fontWeight: '600',
    },
    configHint: {
      color: c.textFaint,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 4,
      marginBottom: 12,
    },
    testError: { color: c.danger, fontSize: 13, marginBottom: 10 },
    testOkRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
    testOk: { color: c.success, fontSize: 13 },
  });
