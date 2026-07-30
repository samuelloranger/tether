import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { MIN_TOUCH_TARGET } from './interaction';
import type { GitLogEntry } from './useTetherApp';

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
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  if (entries.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={{ color: theme.colors.text }}>No commits</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {entries.map((entry) => (
        <TouchableOpacity
          key={entry.sha}
          accessibilityRole="button"
          style={[styles.commitRow, { borderBottomColor: theme.colors.border }]}
          onPress={() => onSelect(entry)}
        >
          <Text numberOfLines={1} style={[styles.commitSubject, { color: theme.colors.text }]}>
            {entry.subject}
          </Text>
          <Text style={[styles.commitMeta, { color: theme.colors.textMuted }]}>
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
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  commitSubject: { fontSize: 14 },
  commitMeta: { fontFamily: 'monospace', fontSize: 12 },
});
