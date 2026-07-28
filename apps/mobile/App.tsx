import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppThemeProvider, useAppTheme } from './src/AppThemeProvider';
import { ConfigScreen } from './src/ConfigScreen';
import { LaunchOverlay } from './src/LaunchOverlay';
import { ServerSettings } from './src/ServerSettings';
import { createStyles } from './src/styles';
import { TerminalScreen } from './src/TerminalScreen';
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
        <AppInner onReady={() => setReady(true)} />
        <LaunchOverlay ready={ready} />
      </AppThemeProvider>
    </SafeAreaProvider>
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
  const serverSettings = (
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
    />
  );
  if (app.isConfiguring) {
    return (
      <SafeAreaView style={[styles.appContainer, { backgroundColor: theme.colors.background }]}>
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
          hosts={app.profiles}
          storeError={app.storeError}
          onRetryHosts={() => void app.loadProfiles()}
          onAddHost={app.openAddHost}
          onEditHost={(hostId) => void app.openEditHost(hostId)}
          onRemoveHost={(hostId) => void app.removeHost(hostId)}
          onUpdateHost={(hostId, changes) => void app.updateProfile(hostId, changes)}
          onReorderHosts={(ids) => void app.reorderHosts(ids)}
          onServerSettings={app.openServerSettings}
          healthByHost={app.healthByHost}
          renderHostPage={(host, onBack) => (
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
              onIdentitySaved={(identity) => void app.saveServerIdentity(identity)}
              onPasswordChanged={(password) => app.replaceStoredPassword(host.id, password)}
            />
          )}
        />
        {serverSettings}
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={[styles.appContainer, { backgroundColor: theme.colors.background }]}
    >
      <TerminalScreen app={app} />
      {serverSettings}
    </SafeAreaView>
  );
}
