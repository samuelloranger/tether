import type { ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { minTouchTarget } from './interaction';

const TOUCH_TARGET = minTouchTarget();

export function GitSectionHeader({
  label,
  count,
  actions,
  padded,
}: {
  label: string;
  count: number;
  actions?: ReactNode;
  /** GitReview list uses horizontal padding; GitDrawer tree does not. */
  padded?: boolean;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={[styles.sectionHeaderRow, padded && styles.padded]}>
      <Text style={[styles.sectionHeader, { color: theme.colors.textMuted }]}>
        {label} ({count})
      </Text>
      {actions}
    </View>
  );
}

export function GitSectionAction({
  label,
  onPress,
  danger,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const { theme } = useAppTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.sectionAction}
    >
      <Text
        style={{
          color: danger ? theme.colors.danger : theme.colors.accent,
          fontSize: 12,
          fontWeight: '600',
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export function GitSectionActions({ children }: { children: ReactNode }) {
  return <View style={styles.sectionActions}>{children}</View>;
}

const styles = StyleSheet.create({
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  padded: {
    marginTop: 12,
    paddingHorizontal: 16,
  },
  sectionActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionAction: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
