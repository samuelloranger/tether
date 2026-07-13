import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { styles } from './src/styles';
import { useTetherApp } from './src/useTetherApp';
import { ConfigScreen } from './src/ConfigScreen';
import { TerminalScreen } from './src/TerminalScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function AppInner() {
  const app = useTetherApp();
  if (!app.fontsLoaded) return null;
  return (
    <SafeAreaView style={styles.appContainer}>
      {app.isConfiguring ? (
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
      ) : (
        <TerminalScreen app={app} />
      )}
    </SafeAreaView>
  );
}
