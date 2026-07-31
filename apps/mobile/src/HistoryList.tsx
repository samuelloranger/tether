import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { minTouchTarget } from './interaction';
import type { GitLogEntry } from './useTetherApp';

const TOUCH_TARGET = minTouchTarget();

export function HistoryList({
  entries,
  onSelect,
}: {
  entries: GitLogEntry[] | null;
  onSelect: (entry: GitLogEntry) => void;
}) {
  const { theme } = useAppTheme();

  if (entries === null) {
    return (
      <View
        style={styles.center}
        accessibilityRole="progressbar"
        accessibilityLabel="Loading commits"
      >
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  if (entries.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={{ color: theme.colors.text }}>No commits yet</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {entries.map((entry) => (
        <TouchableOpacity
          key={entry.sha}
          accessibilityRole="button"
          accessibilityLabel={`Commit ${entry.shortSha}: ${entry.subject}`}
          style={[styles.commitRow, { borderBottomColor: theme.colors.border }]}
          onPress={() => onSelect(entry)}
        >
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1.35}
            style={[styles.commitSubject, { color: theme.colors.text }]}
          >
            {entry.subject}
          </Text>
          <Text
            maxFontSizeMultiplier={1.35}
            style={[styles.commitMeta, { color: theme.colors.textMuted }]}
          >
            {entry.shortSha} · {entry.author} · {new Date(entry.date).toLocaleDateString()}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, alignItems: 'stretch' },
  commitRow: {
    minHeight: TOUCH_TARGET,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  commitSubject: { fontSize: 14 },
  commitMeta: { fontFamily: 'monospace', fontSize: 12 },
});
