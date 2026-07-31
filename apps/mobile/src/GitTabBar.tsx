import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { minTouchTarget } from './interaction';

const TOUCH_TARGET = minTouchTarget();

export function GitTabBar({
  tab,
  onChanges,
  onHistory,
}: {
  tab: 'changes' | 'history';
  onChanges: () => void;
  onHistory: () => void;
}) {
  const { theme } = useAppTheme();

  return (
    <View
      accessibilityRole="tablist"
      style={[styles.tabs, { borderBottomColor: theme.colors.border }]}
    >
      {(
        [
          { key: 'changes' as const, label: 'Working tree', onPress: onChanges },
          { key: 'history' as const, label: 'History', onPress: onHistory },
        ] as const
      ).map((t) => (
        <TouchableOpacity
          key={t.key}
          accessibilityRole="tab"
          accessibilityLabel={t.label}
          accessibilityState={{ selected: tab === t.key }}
          onPress={t.onPress}
          style={[
            styles.tab,
            tab === t.key && { borderBottomColor: theme.colors.accent, borderBottomWidth: 2 },
          ]}
        >
          <Text
            style={{
              color: tab === t.key ? theme.colors.accent : theme.colors.textMuted,
              fontWeight: tab === t.key ? '600' : '400',
            }}
          >
            {t.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
