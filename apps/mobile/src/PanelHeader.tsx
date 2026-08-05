import type { ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { minTouchTarget } from './interaction';

const TOUCH_TARGET = minTouchTarget();
const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;

/** Back/close chrome + title used by FileViewer, GitReview, and GitDrawer. */
export function PanelHeader({
  onBack,
  backAccessibilityLabel,
  backText = 'Back',
  title,
  subtitle,
  right,
}: {
  onBack: () => void;
  backAccessibilityLabel: string;
  backText?: string;
  title: string;
  subtitle?: string | null;
  right?: ReactNode;
}) {
  const { theme } = useAppTheme();
  const titleBlock = (
    <View style={subtitle ? styles.headerTitles : styles.titleOnly}>
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.35}
        style={[styles.path, !subtitle && styles.pathWithMargin, { color: theme.colors.text }]}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={1.35}
          style={[styles.subtitle, { color: theme.colors.textMuted }]}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={backAccessibilityLabel}
        onPress={onBack}
        style={styles.back}
      >
        <Text style={[styles.backText, { color: theme.colors.accent }]}>{backText}</Text>
      </TouchableOpacity>
      {titleBlock}
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 48,
  },
  back: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { ...TEXT_METRICS },
  headerTitles: { flex: 1, marginRight: 16, minWidth: 0 },
  titleOnly: { flex: 1, minWidth: 0 },
  path: { fontFamily: 'monospace', ...TEXT_METRICS },
  pathWithMargin: { marginRight: 16 },
  subtitle: { fontFamily: 'monospace', fontSize: 12, marginTop: 2 },
});
