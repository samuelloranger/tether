import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { diffLineKind, displayDiff, type DiffSummary } from './diffModel';
import { CodeHighlight } from './CodeHighlight';

export function DiffView({
  summary,
  selectedPath,
  diffText,
  diffTruncated,
  diffLoading,
  onSelectFile,
  onDeselectFile,
  onBack,
}: {
  summary: DiffSummary;
  selectedPath: string | null;
  diffText: string | null;
  diffTruncated: boolean;
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
            <CodeHighlight
              path={selectedPath}
              code={displayDiff(diffText ?? '', diffTruncated)}
              lineStyle={(line) => {
                const kind = diffLineKind(line);
                if (kind === 'add') return { backgroundColor: `${theme.colors.success}18` };
                if (kind === 'remove') return { backgroundColor: `${theme.colors.danger}18` };
                if (kind === 'meta') return { backgroundColor: theme.colors.surfaceRaised, opacity: 0.8 };
                return undefined;
              }}
            />
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
  content: { padding: 16, alignItems: 'stretch' },
  fileRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
  filePath: { fontFamily: 'monospace', flex: 1, marginRight: 12 },
  fileStat: { fontFamily: 'monospace' },
});
