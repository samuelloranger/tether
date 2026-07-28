import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppThemeProvider, useAppTheme } from './src/AppThemeProvider';
import { ConfigScreen } from './src/ConfigScreen';
import { LaunchOverlay } from './src/LaunchOverlay';
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
        />
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={[styles.appContainer, { backgroundColor: theme.colors.background }]}
    >
      <TerminalScreen app={app} />
    </SafeAreaView>
  );
}
