import type React from 'react';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { desktopLayout } from './desktopLayout';
import { HostsScreen } from './HostsScreen';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import { isDesktop, isMacDesktop } from './platform';
import { createStyles } from './styles';
import TitleBar from './TitleBar';
import type { HostHealthStatus } from './tether/hostHealth';
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
  onCloseSettings,
  hosts,
  storeError,
  onRetryHosts,
  onAddHost,
  onReorderHosts,
  healthByHost,
  initialHostId,
  onHostPageClose,
  renderHostPage,
  renderAppearancePage,
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
  onCloseSettings: () => void;
  hosts?: HostProfile[] | null;
  storeError?: string | null;
  onRetryHosts?: () => void;
  onAddHost?: () => void;
  onReorderHosts?: (ids: string[]) => void;
  healthByHost?: Record<string, HostHealthStatus>;
  initialHostId?: string | null;
  onHostPageClose?: () => void;
  renderHostPage?: (host: HostProfile, onBack: () => void) => React.ReactNode;
  renderAppearancePage?: (onBack: () => void) => React.ReactNode;
}) {
  const { theme } = useAppTheme();
  const shared = createStyles(theme.colors);
  const styles = createConfigStyles(theme.colors);
  const { width } = useWindowDimensions();
  const desktopUi = desktopLayout(isDesktop, width) === 'desktop';
  // Settings opens on the Hosts list. The three-input connection form is for
  // adding or repairing one host, not the front door — with hosts configured,
  // landing there asked "which server?" when the answer was already stored.
  const [hostsOpen, setHostsOpen] = useState(true);
  const [openHostId, setOpenHostId] = useState<string | null>(initialHostId ?? null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  useEffect(() => {
    if (initialHostId) setOpenHostId(initialHostId);
  }, [initialHostId]);
  const openHost = openHostId ? hosts?.find((host) => host.id === openHostId) : null;
  const showHosts = hostsOpen && !!hosts && !!onAddHost && !!onReorderHosts;
  const desktopChrome = isDesktop ? (
    <TitleBar
      isMac={isMacDesktop}
      title={
        appearanceOpen
          ? 'Appearance'
          : openHost
            ? `${openHost.name} settings`
            : showHosts
              ? 'Settings'
              : 'Tether'
      }
      compact={!desktopUi}
    />
  ) : null;
  if (storeError) {
    return (
      <>
        {desktopChrome}
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
      </>
    );
  }
  // One host, one page — rendered as a screen, not an overlay.
  if (openHost && renderHostPage)
    return (
      <>
        {desktopChrome}
        {renderHostPage(openHost, () => {
          setOpenHostId(null);
          onHostPageClose?.();
        })}
      </>
    );
  if (appearanceOpen && renderAppearancePage)
    return (
      <>
        {desktopChrome}
        {renderAppearancePage(() => setAppearanceOpen(false))}
      </>
    );
  if (showHosts && hosts && onAddHost && onReorderHosts) {
    return (
      <>
        {desktopChrome}
        <HostsScreen
          hosts={hosts}
          health={healthByHost}
          onBack={onCloseSettings}
          onAppearance={() => setAppearanceOpen(true)}
          onAdd={() => {
            setHostsOpen(false);
            onAddHost();
          }}
          // One destination per host. The drawer gear lands here too, so the
          // ambiguity that left this screen unreachable cannot come back.
          onOpen={(id) => setOpenHostId(id)}
          onReorder={onReorderHosts}
        />
      </>
    );
  }
  return (
    <>
      {/* Desktop: frameless window still needs drag + close/min/max here too. */}
      {desktopChrome}
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
              onPress={() => setHostsOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Manage hosts"
              style={styles.manageHosts}
            >
              <Text style={{ color: theme.colors.accent }}>Manage hosts</Text>
            </TouchableOpacity>
          )}

          <View style={styles.formContainer}>
            <Text style={styles.inputLabel}>Server</Text>
            <TextInput
              style={styles.configInput}
              value={serverIp}
              onChangeText={(t) => {
                setServerIp(t);
                setSetupMode('unknown');
                setTestStatus({ kind: 'idle' });
              }}
              placeholder="e.g. 192.168.50.30"
              accessibilityLabel="Server IP or host"
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
              accessibilityLabel="Port"
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
              accessibilityLabel="Password"
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
                  accessibilityLabel="Confirm password"
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
      paddingHorizontal: 28,
      backgroundColor: c.background,
    },
    // Caps the login form width so it doesn't stretch across a wide desktop window.
    configInner: {
      width: '100%',
      maxWidth: 400,
    },
    configBrandRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    configTitle: {
      fontSize: 34,
      fontWeight: '700',
      letterSpacing: -0.6,
      color: c.text,
    },
    configModeTag: {
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      color: c.textFaint,
    },
    configRule: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
      marginBottom: 10,
    },
    configSubtitle: {
      fontSize: 13,
      color: c.textMuted,
      marginBottom: 8,
      maxWidth: 280,
    },
    manageHosts: { marginBottom: 20, alignSelf: 'flex-start' },
    formContainer: {
      backgroundColor: 'transparent',
      paddingTop: 8,
    },
    inputLabel: {
      fontSize: 12,
      fontWeight: '500',
      color: c.textMuted,
      marginBottom: 6,
    },
    configInput: {
      backgroundColor: 'transparent',
      borderWidth: 0,
      borderBottomWidth: 1,
      borderColor: c.border,
      borderRadius: 0,
      color: c.text,
      fontSize: 15,
      paddingVertical: 10,
      paddingHorizontal: 0,
      marginBottom: 18,
    },
    connectBtn: {
      backgroundColor: c.accent,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: 18,
      borderRadius: SURFACE_RADIUS.hero,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 8,
      marginTop: 10,
      alignSelf: 'flex-start',
    },
    connectBtnDisabled: { opacity: 0.65 },
    connectBtnText: {
      color: c.accentText,
      fontSize: 14,
      fontWeight: '700',
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
