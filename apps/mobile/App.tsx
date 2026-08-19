import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppearanceScreen } from './src/AppearanceScreen';
import { AppThemeProvider, useAppTheme } from './src/AppThemeProvider';
import { ConfigScreen } from './src/ConfigScreen';
import { LaunchOverlay } from './src/LaunchOverlay';
import { PopupOverlayProvider } from './src/PopupOverlay';
import { ServerSettings } from './src/ServerSettings';
import { createStyles } from './src/styles';
import { TerminalScreen } from './src/TerminalScreen';
import { TetherProvider, useChrome, useConnection, useSession } from './src/tether/context';
import type { HostProfile } from './src/tether/hostStore';

// Hold the native splash until the JS side has painted its identical overlay
// (see LaunchOverlay); the default auto-hide fires at bundle load and exposes a
// blank frame while fonts/config resolve.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const [ready, setReady] = useState(false);
  return (
    <SafeAreaProvider>
      <AppThemeProvider>
        <PopupOverlayProvider>
          {/* TetherProvider sits inside these three: the hook graph calls
              useSafeAreaInsets() and useAppTheme(). */}
          <TetherProvider>
            <AppInner onReady={() => setReady(true)} />
          </TetherProvider>
          <LaunchOverlay ready={ready} />
        </PopupOverlayProvider>
      </AppThemeProvider>
    </SafeAreaProvider>
  );
}

function AppServerSettings() {
  const conn = useConnection();
  const { healthByHost, refreshHost } = useSession();
  const host = conn.serverSettingsHost;
  return (
    <ServerSettings
      visible={conn.serverSettingsOpen}
      host={host}
      client={conn.serverSettingsClient}
      health={host ? (healthByHost[host.id] ?? 'unknown') : 'unknown'}
      onClose={conn.closeServerSettings}
      onRetry={() => host && refreshHost(host.id)}
      onUnauthorized={() => {
        conn.closeServerSettings();
        if (host) void conn.openEditHost(host.id);
      }}
      onIdentitySaved={(identity) => void conn.saveServerIdentity(identity)}
      onPasswordChanged={(password) =>
        host ? conn.replaceStoredPassword(host.id, password) : Promise.resolve()
      }
      onConnectionSaved={(changes, password) =>
        host ? conn.saveHostConnection(host.id, changes, password) : Promise.resolve()
      }
      onRemoveHost={async () => {
        if (host) await conn.removeHost(host.id);
      }}
    />
  );
}

function AppHostPage({ host, onBack }: { host: HostProfile; onBack: () => void }) {
  const conn = useConnection();
  const { healthByHost, refreshHost } = useSession();
  return (
    <ServerSettings
      inline
      visible
      host={host}
      client={conn.clientFor(host)}
      health={healthByHost[host.id] ?? 'unknown'}
      onClose={onBack}
      onRetry={() => refreshHost(host.id)}
      onUnauthorized={() => {
        onBack();
        void conn.openEditHost(host.id);
      }}
      onIdentitySaved={(identity) => void conn.saveHostIdentity(host.id, identity)}
      onPasswordChanged={(password) => conn.replaceStoredPassword(host.id, password)}
      onConnectionSaved={(changes, password) => conn.saveHostConnection(host.id, changes, password)}
      onRemoveHost={() => conn.removeHost(host.id)}
    />
  );
}

function AppAppearancePage({ onBack }: { onBack: () => void }) {
  const { fontFamily, changeFontFamily } = useChrome();
  return (
    <AppearanceScreen fontFamily={fontFamily} onFontChange={changeFontFamily} onBack={onBack} />
  );
}

function AppConfigScreen() {
  const conn = useConnection();
  const { healthByHost } = useSession();
  return (
    <ConfigScreen
      serverIp={conn.serverIp}
      setServerIp={conn.setServerIp}
      port={conn.port}
      setPort={conn.setPort}
      password={conn.password}
      setPassword={conn.setPassword}
      confirmPassword={conn.confirmPassword}
      setConfirmPassword={conn.setConfirmPassword}
      setupMode={conn.setupMode}
      setSetupMode={conn.setSetupMode}
      testStatus={conn.testStatus}
      setTestStatus={conn.setTestStatus}
      onSave={conn.saveConfig}
      onTest={conn.testConnection}
      onCloseSettings={() => conn.setIsConfiguring(false)}
      hosts={conn.profiles}
      storeError={conn.storeError}
      onRetryHosts={() => void conn.loadProfiles()}
      onAddHost={conn.openAddHost}
      onReorderHosts={(ids) => void conn.reorderHosts(ids)}
      healthByHost={healthByHost}
      initialHostId={conn.serverSettingsHost?.id}
      onHostPageClose={conn.closeServerSettings}
      renderHostPage={(host, onBack) => <AppHostPage host={host} onBack={onBack} />}
      renderAppearancePage={(onBack) => <AppAppearancePage onBack={onBack} />}
    />
  );
}

function AppInner({ onReady }: { onReady: () => void }) {
  const { fontsLoaded } = useChrome();
  const { isConfiguring } = useConnection();
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  useEffect(() => {
    if (fontsLoaded) onReady();
  }, [fontsLoaded, onReady]);
  if (!fontsLoaded) return null;
  // Rendered once, above both branches. Mounted inside a branch it unmounted
  // mid-flight when the app flipped config <-> terminal, and react-native-web
  // left the open Modal's backdrop behind — a permanent dim over a dead app.
  const serverSettings = <AppServerSettings />;
  if (isConfiguring) {
    return (
      <SafeAreaView style={[styles.appContainer, { backgroundColor: theme.colors.background }]}>
        <AppConfigScreen />
        {serverSettings}
      </SafeAreaView>
    );
  }
  // No SafeAreaView padding here: that wrapped the terminal in bezel-colored
  // gaps. Insets are applied inside the terminal well / utility bar / takeovers
  // so the PTY background goes edge-to-edge.
  return (
    <View style={[styles.appContainer, { backgroundColor: theme.colors.background }]}>
      <TerminalScreen />
      {serverSettings}
    </View>
  );
}
