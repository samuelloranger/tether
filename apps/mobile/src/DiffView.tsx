import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { DiffSummary } from './diffModel';

export function DiffView({
  summary,
  selectedPath,
  diffText,
  diffLoading,
  onSelectFile,
  onDeselectFile,
  onBack,
}: {
  summary: DiffSummary;
  selectedPath: string | null;
  diffText: string | null;
  diffLoading: boolean;
  onSelectFile: (path: string) => void;
  onDeselectFile: () => void;
  onBack: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={selectedPath ? 'Back to changed files' : 'Back to terminal'}
          onPress={selectedPath ? onDeselectFile : onBack}
          style={styles.back}
        >
          <Text style={{ color: theme.colors.accent }}>Back</Text>
        </TouchableOpacity>
        <Text numberOfLines={1} style={[styles.path, { color: theme.colors.text }]}>
          {selectedPath ?? 'Changes'}
        </Text>
      </View>
      {selectedPath ? (
        diffLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : (
          <ScrollView style={styles.vertical} contentContainerStyle={styles.content}>
            <ScrollView horizontal contentContainerStyle={styles.horizontal}>
              <Text selectable style={[styles.code, { color: theme.terminal.fg }]}>
                {diffText ?? ''}
              </Text>
            </ScrollView>
          </ScrollView>
        )
      ) : summary.files.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.text }}>No changes</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {summary.files.map((file) => (
            <TouchableOpacity key={file.path} style={styles.fileRow} onPress={() => onSelectFile(file.path)}>
              <Text numberOfLines={1} style={[styles.filePath, { color: theme.colors.text }]}>
                {file.path}
              </Text>
              <Text style={styles.fileStat}>
                <Text style={{ color: theme.colors.success }}>+{file.insertions}</Text>{' '}
                <Text style={{ color: theme.colors.danger }}>-{file.deletions}</Text>
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48 },
  back: { paddingHorizontal: 16, paddingVertical: 12 },
  path: { flex: 1, fontFamily: 'monospace', marginRight: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  vertical: { flex: 1 },
  content: { padding: 16 },
  horizontal: { minWidth: '100%' },
  code: { fontFamily: 'monospace', fontSize: 14, lineHeight: 20 },
  fileRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
  filePath: { fontFamily: 'monospace', flex: 1, marginRight: 12 },
  fileStat: { fontFamily: 'monospace' },
});
