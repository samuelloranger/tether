import Feather from '@expo/vector-icons/Feather';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';

// A standing, tappable link between a terminal session and its open preview —
// shown on the terminal screen pointing at the preview, and on the preview
// screen pointing back at the terminal, using the same layout either way.
export function PresentationBanner({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: 'layout' | 'terminal';
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  return (
    <TouchableOpacity
      style={styles.presentationBanner}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name={icon} size={14} color={theme.colors.info} />
      <Text style={styles.presentationBannerText} numberOfLines={1}>
        {label}
      </Text>
      <Feather name="chevron-right" size={14} color={theme.colors.textMuted} />
    </TouchableOpacity>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    presentationBanner: {
      backgroundColor: c.surfaceRaised,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingVertical: 6,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    presentationBannerText: {
      flex: 1,
      fontSize: 12,
      color: c.info,
      fontWeight: '600',
    },
  });
}
