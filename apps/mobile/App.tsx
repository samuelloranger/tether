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
import type { TetherApp } from './src/terminalScreenTypes';
import type { HostProfile } from './src/tether/hostStore';
import { useTetherApp } from './src/useTetherApp';

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
          <AppInner onReady={() => setReady(true)} />
          <LaunchOverlay ready={ready} />
        </PopupOverlayProvider>
      </AppThemeProvider>
    </SafeAreaProvider>
  );
}

function AppServerSettings({ app }: { app: TetherApp }) {
  return (
    <ServerSettings
      visible={app.serverSettingsOpen}
      host={app.serverSettingsHost}
      client={app.serverSettingsClient}
      health={
        app.serverSettingsHost
          ? (app.healthByHost[app.serverSettingsHost.id] ?? 'unknown')
          : 'unknown'
      }
      onClose={app.closeServerSettings}
      onRetry={() => app.serverSettingsHost && app.refreshHost(app.serverSettingsHost.id)}
      onUnauthorized={() => {
        const host = app.serverSettingsHost;
        app.closeServerSettings();
        if (host) void app.openEditHost(host.id);
      }}
      onIdentitySaved={(identity) => void app.saveServerIdentity(identity)}
      onPasswordChanged={(password) =>
        app.serverSettingsHost
          ? app.replaceStoredPassword(app.serverSettingsHost.id, password)
          : Promise.resolve()
      }
      onConnectionSaved={(changes, password) =>
        app.serverSettingsHost
          ? app.saveHostConnection(app.serverSettingsHost.id, changes, password)
          : Promise.resolve()
      }
      onRemoveHost={async () => {
        if (app.serverSettingsHost) await app.removeHost(app.serverSettingsHost.id);
      }}
    />
  );
}

function AppHostPage({
  app,
  host,
  onBack,
}: {
  app: TetherApp;
  host: HostProfile;
  onBack: () => void;
}) {
  return (
    <ServerSettings
      inline
      visible
      host={host}
      client={app.clientFor(host)}
      health={app.healthByHost[host.id] ?? 'unknown'}
      onClose={onBack}
      onRetry={() => app.refreshHost(host.id)}
      onUnauthorized={() => {
        onBack();
        void app.openEditHost(host.id);
      }}
      onIdentitySaved={(identity) => void app.saveHostIdentity(host.id, identity)}
      onPasswordChanged={(password) => app.replaceStoredPassword(host.id, password)}
      onConnectionSaved={(changes, password) => app.saveHostConnection(host.id, changes, password)}
      onRemoveHost={() => app.removeHost(host.id)}
    />
  );
}

function AppConfigScreen({ app }: { app: TetherApp }) {
  return (
    <ConfigScreen
      serverIp={app.serverIp}
      setServerIp={app.setServerIp}
      port={app.port}
      setPort={app.setPort}
      password={app.password}
      setPassword={app.setPassword}
      confirmPassword={app.confirmPassword}
      setConfirmPassword={app.setConfirmPassword}
      setupMode={app.setupMode}
      setSetupMode={app.setSetupMode}
      testStatus={app.testStatus}
      setTestStatus={app.setTestStatus}
      onSave={app.saveConfig}
      onTest={app.testConnection}
      onCloseSettings={() => app.setIsConfiguring(false)}
      hosts={app.profiles}
      storeError={app.storeError}
      onRetryHosts={() => void app.loadProfiles()}
      onAddHost={app.openAddHost}
      onReorderHosts={(ids) => void app.reorderHosts(ids)}
      healthByHost={app.healthByHost}
      initialHostId={app.serverSettingsHost?.id}
      onHostPageClose={app.closeServerSettings}
      renderHostPage={(host, onBack) => <AppHostPage app={app} host={host} onBack={onBack} />}
      renderAppearancePage={(onBack) => (
        <AppearanceScreen
          fontFamily={app.fontFamily}
          onFontChange={app.changeFontFamily}
          onBack={onBack}
        />
      )}
    />
  );
}

function AppInner({ onReady }: { onReady: () => void }) {
  const app = useTetherApp();
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  const launchReady = app.fontsLoaded;
  useEffect(() => {
    if (launchReady) onReady();
  }, [launchReady, onReady]);
  if (!app.fontsLoaded) return null;
  // Rendered once, above both branches. Mounted inside a branch it unmounted
  // mid-flight when the app flipped config <-> terminal, and react-native-web
  // left the open Modal's backdrop behind — a permanent dim over a dead app.
  const serverSettings = <AppServerSettings app={app} />;
  if (app.isConfiguring) {
    return (
      <SafeAreaView style={[styles.appContainer, { backgroundColor: theme.colors.background }]}>
        <AppConfigScreen app={app} />
        {serverSettings}
      </SafeAreaView>
    );
  }
  // No SafeAreaView padding here: that wrapped the terminal in bezel-colored
  // gaps. Insets are applied inside the terminal well / utility bar / takeovers
  // so the PTY background goes edge-to-edge.
  return (
    <View style={[styles.appContainer, { backgroundColor: theme.colors.background }]}>
      <TerminalScreen app={app} />
      {serverSettings}
    </View>
  );
}
