import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, Keyboard, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from './AppThemeProvider';
import type { TerminalStyles, TetherApp } from './terminalScreenTypes';

function ConnectionStatusBadge({
  status,
  styles,
  warningColor,
}: {
  status: TetherApp['connectionStatus'];
  styles: TerminalStyles;
  warningColor: string;
}) {
  if (status === 'connected') {
    return (
      <View style={[styles.statusBadge, styles.badgeConnected]}>
        <Text style={styles.badgeTextConnected}>online</Text>
      </View>
    );
  }
  if (status === 'auth-failed') {
    return (
      <View style={[styles.statusBadge, styles.badgeOffline]}>
        <Text style={styles.badgeTextOffline}>auth</Text>
      </View>
    );
  }
  if (status === 'connecting') {
    return (
      <View style={[styles.statusBadge, styles.badgeConnecting]}>
        <ActivityIndicator size={8} color={warningColor} style={styles.spinIcon} />
        <Text style={styles.badgeTextConnecting}>connecting</Text>
      </View>
    );
  }
  return (
    <View style={[styles.statusBadge, styles.badgeOffline]}>
      <Text style={styles.badgeTextOffline}>offline</Text>
    </View>
  );
}

export function TerminalMobileHeader({
  app,
  styles,
  terminalVisible,
}: {
  app: TetherApp;
  styles: TerminalStyles;
  terminalVisible: boolean;
}) {
  const { theme } = useAppTheme();
  const {
    connectionStatus,
    activePresentation,
    activeName,
    serverIp,
    port,
    refreshSessions,
    refreshPresentations,
    setDrawerOpen,
    setMenuOpen,
  } = app;
  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={{ backgroundColor: theme.colors.surface }}
    >
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerBtn}
          activeOpacity={0.6}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={() => {
            Keyboard.dismiss();
            refreshSessions();
            refreshPresentations();
            setDrawerOpen(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Open terminal list"
        >
          <Feather name="menu" size={20} color={theme.colors.text} />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={styles.headerTitle}>{activePresentation?.title || activeName}</Text>
          <Text style={styles.headerSubtitle}>
            {serverIp}:{port}
          </Text>
        </View>
        <View style={styles.headerControls}>
          <ConnectionStatusBadge
            status={connectionStatus}
            styles={styles}
            warningColor={theme.colors.warning}
          />
          {terminalVisible && (
            <TouchableOpacity
              style={styles.headerBtn}
              activeOpacity={0.6}
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              onPress={() => setMenuOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Terminal menu"
            >
              <Feather name="more-vertical" size={19} color={theme.colors.text} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
