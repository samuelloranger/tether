import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

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

const styles = StyleSheet.create({
  reconnectBanner: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(245, 158, 11, 0.25)',
    paddingVertical: 6,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  reconnectBannerText: {
    fontSize: 10,
    color: '#fcd34d',
    textAlign: 'center',
  },
  reconnectBannerEdit: {
    fontSize: 11,
    color: '#22d3ee',
    fontWeight: '600',
  },
});
