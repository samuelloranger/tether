import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';

type Status = 'connecting' | 'connected' | 'disconnected' | 'auth-failed';

// Names the real connection state; renders nothing while connected.
export function ConnectionBanner({
  status,
  hasConnected,
  onEdit,
}: {
  status: Status;
  hasConnected: boolean;
  onEdit: () => void;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  if (status === 'connected') return null;
  return (
    <View style={styles.reconnectBanner}>
      <Text style={styles.reconnectBannerText}>
        {status === 'auth-failed'
          ? 'Wrong password.'
          : hasConnected
            ? 'Reconnecting… (session kept running on the server)'
            : 'Connecting…'}
      </Text>
      <TouchableOpacity
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel="Edit connection settings"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.reconnectBannerEdit}>Edit</Text>
      </TouchableOpacity>
    </View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
  reconnectBanner: {
    backgroundColor: c.surfaceRaised,
    borderBottomWidth: 1,
    borderBottomColor: c.warning,
    paddingVertical: 6,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  reconnectBannerText: {
    fontSize: 10,
    color: c.warning,
    textAlign: 'center',
  },
  reconnectBannerEdit: {
    fontSize: 11,
    color: c.info,
    fontWeight: '600',
  },
  });
}
