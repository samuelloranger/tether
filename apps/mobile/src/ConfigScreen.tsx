import type React from 'react';
import { useEffect, useState } from 'react';
import { Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { ConfigConnectionForm } from './configScreenForm';
import { createConfigStyles } from './configScreenStyles';
import { desktopLayout } from './desktopLayout';
import { HostsScreen } from './HostsScreen';
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

export type ConfigScreenProps = {
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
};

function configTitle(
  appearanceOpen: boolean,
  openHost: HostProfile | null | undefined,
  showHosts: boolean,
) {
  if (appearanceOpen) return 'Appearance';
  if (openHost) return `${openHost.name} settings`;
  if (showHosts) return 'Settings';
  return 'Tether';
}

function ConfigErrorPage({
  chrome,
  styles,
  storeError,
  onRetryHosts,
}: {
  chrome: React.ReactNode;
  styles: ReturnType<typeof createConfigStyles>;
  storeError: string;
  onRetryHosts?: () => void;
}) {
  return (
    <>
      {chrome}
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

function formBind(p: ConfigScreenProps) {
  return {
    serverIp: p.serverIp,
    setServerIp: p.setServerIp,
    port: p.port,
    setPort: p.setPort,
    password: p.password,
    setPassword: p.setPassword,
    confirmPassword: p.confirmPassword,
    setConfirmPassword: p.setConfirmPassword,
    setupMode: p.setupMode,
    setSetupMode: p.setSetupMode,
    testStatus: p.testStatus,
    setTestStatus: p.setTestStatus,
    onSave: p.onSave,
    onTest: p.onTest,
    hosts: p.hosts,
  };
}

export function ConfigScreen(p: ConfigScreenProps) {
  const { theme } = useAppTheme();
  const shared = createStyles(theme.colors);
  const styles = createConfigStyles(theme.colors);
  const { width } = useWindowDimensions();
  const desktopUi = desktopLayout(isDesktop, width) === 'desktop';
  const [hostsOpen, setHostsOpen] = useState(true);
  const [openHostId, setOpenHostId] = useState<string | null>(p.initialHostId ?? null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  useEffect(() => {
    if (p.initialHostId) setOpenHostId(p.initialHostId);
  }, [p.initialHostId]);
  const openHost = openHostId ? p.hosts?.find((host) => host.id === openHostId) : null;
  const showHosts = hostsOpen && !!p.hosts && !!p.onAddHost && !!p.onReorderHosts;
  const chrome = isDesktop ? (
    <TitleBar
      isMac={isMacDesktop}
      title={configTitle(appearanceOpen, openHost, showHosts)}
      compact={!desktopUi}
    />
  ) : null;
  if (p.storeError) {
    return (
      <ConfigErrorPage
        chrome={chrome}
        styles={styles}
        storeError={p.storeError}
        onRetryHosts={p.onRetryHosts}
      />
    );
  }
  if (openHost && p.renderHostPage) {
    return (
      <>
        {chrome}
        {p.renderHostPage(openHost, () => {
          setOpenHostId(null);
          p.onHostPageClose?.();
        })}
      </>
    );
  }
  if (appearanceOpen && p.renderAppearancePage) {
    return (
      <>
        {chrome}
        {p.renderAppearancePage(() => setAppearanceOpen(false))}
      </>
    );
  }
  if (showHosts && p.hosts && p.onAddHost && p.onReorderHosts) {
    return (
      <>
        {chrome}
        <HostsScreen
          hosts={p.hosts}
          health={p.healthByHost}
          onBack={p.onCloseSettings}
          onAppearance={() => setAppearanceOpen(true)}
          onAdd={() => {
            setHostsOpen(false);
            p.onAddHost?.();
          }}
          onOpen={(id) => setOpenHostId(id)}
          onReorder={p.onReorderHosts}
        />
      </>
    );
  }
  return (
    <>
      {chrome}
      <ConfigConnectionForm
        styles={styles}
        shared={shared}
        theme={theme}
        onManageHosts={() => setHostsOpen(true)}
        {...formBind(p)}
      />
    </>
  );
}
