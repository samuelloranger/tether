import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, Keyboard, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from './AppThemeProvider';
import type { TerminalStyles } from './terminalScreenTypes';
import type { Session } from './tether/context';
import { useConnection, usePresentation, useSession, useUi } from './tether/context';

function ConnectionStatusBadge({
  status,
  styles,
  warningColor,
}: {
  status: Session['connectionStatus'];
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
  styles,
  terminalVisible,
  docked = false,
}: {
  styles: TerminalStyles;
  terminalVisible: boolean;
  /** The session list is already pinned beside us — the menu button is dead weight. */
  docked?: boolean;
}) {
  const { theme } = useAppTheme();
  const { connectionStatus, activeName, refreshSessions } = useSession();
  const { serverIp, port } = useConnection();
  const { activePresentation, refreshPresentations } = usePresentation();
  const { setDrawerOpen, setMenuOpen } = useUi();
  return (
    <SafeAreaView
      edges={docked ? ['top', 'right'] : ['top', 'left', 'right']}
      style={{ backgroundColor: theme.colors.surface }}
    >
      <View style={styles.header}>
        {!docked && (
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
        )}
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
