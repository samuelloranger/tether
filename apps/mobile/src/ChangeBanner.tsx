import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { changeBannerLabel, type DiffSummary } from './diffModel';

export function ChangeBanner({ summary, onPress }: { summary: DiffSummary; onPress: () => void }) {
  const { theme } = useAppTheme();
  const accessibilityLabel = changeBannerLabel(summary);
  if (!accessibilityLabel) return null;
  const insertions = summary.files.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = summary.files.reduce((sum, file) => sum + file.deletions, 0);
  const styles = createStyles(theme.colors);

  return (
    <TouchableOpacity
      style={styles.banner}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={styles.label}>Changes</Text>
      <Text style={styles.insertions}>+{insertions}</Text>
      <Text style={styles.deletions}>-{deletions}</Text>
    </TouchableOpacity>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    banner: {
      backgroundColor: c.surfaceRaised,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingVertical: 6,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    label: { flex: 1, color: c.text, fontSize: 12, fontWeight: '600' },
    insertions: { color: c.success, fontSize: 12, fontWeight: '700' },
    deletions: { color: c.danger, fontSize: 12, fontWeight: '700' },
  });
}
