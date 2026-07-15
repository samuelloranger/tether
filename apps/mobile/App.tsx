import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createStyles } from './src/styles';
import { useTetherApp } from './src/useTetherApp';
import { ConfigScreen } from './src/ConfigScreen';
import { TerminalScreen } from './src/TerminalScreen';
import { AppThemeProvider, useAppTheme } from './src/AppThemeProvider';

export default function App() {
  return (
    <SafeAreaProvider>
      <AppThemeProvider>
        <AppInner />
      </AppThemeProvider>
    </SafeAreaProvider>
  );
}

function AppInner() {
  const app = useTetherApp();
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
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
