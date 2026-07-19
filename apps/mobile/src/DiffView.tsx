import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useAppTheme } from './AppThemeProvider';
import { displayDiff, groupFilesByDirectory, isImagePath, type DiffSummary } from './diffModel';
import { DiffLines } from './DiffLines';
import { ImageDiff } from './ImageDiff';

const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;

export function DiffView({
  summary,
  selectedPath,
  diffText,
  diffTruncated,
  diffLoading,
  diffImage,
  onSelectFile,
  onDeselectFile,
  onBack,
}: {
  summary: DiffSummary;
  selectedPath: string | null;
  diffText: string | null;
  diffTruncated: boolean;
  diffLoading: boolean;
  diffImage: { old: string | null; new: string | null } | null;
  onSelectFile: (path: string) => void;
  onDeselectFile: () => void;
  onBack: () => void;
}) {
  const { theme } = useAppTheme();
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const selectedFile = summary.files.find((file) => file.path === selectedPath) ?? null;
  const isImage = selectedFile ? selectedFile.binary && isImagePath(selectedFile.path) : false;

  const toggleDir = (dir: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={selectedPath ? 'Back to changed files' : 'Back to terminal'}
          onPress={selectedPath ? onDeselectFile : onBack}
          style={styles.back}
        >
          <Text style={[styles.backText, { color: theme.colors.accent }]}>Back</Text>
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
        ) : isImage ? (
          <ImageDiff
            oldUri={diffImage?.old ?? null}
            newUri={diffImage?.new ?? null}
            loading={false}
          />
        ) : (
          <ScrollView style={styles.vertical} contentContainerStyle={styles.content}>
            <DiffLines diffText={displayDiff(diffText ?? '', diffTruncated)} path={selectedPath} />
          </ScrollView>
        )
      ) : summary.files.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.text }}>No changes</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {groupFilesByDirectory(summary.files).map((group) => {
            const collapsed = collapsedDirs.has(group.dir);
            return (
              <View key={group.dir || '.'}>
                {group.dir !== '' && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    style={styles.dirRow}
                    onPress={() => toggleDir(group.dir)}
                  >
                    <Feather
                      name={collapsed ? 'chevron-right' : 'chevron-down'}
                      size={14}
                      color={theme.colors.textMuted}
                    />
                    <Text numberOfLines={1} style={[styles.dirLabel, { color: theme.colors.textMuted }]}>
                      {group.dir}
                    </Text>
                  </TouchableOpacity>
                )}
                {!collapsed &&
                  group.files.map((file) => (
                    <TouchableOpacity
                      key={file.path}
                      style={styles.fileRow}
                      onPress={() => onSelectFile(file.path)}
                    >
                      <Text numberOfLines={1} style={[styles.filePath, { color: theme.colors.text }]}>
                        {file.path.slice(group.dir ? group.dir.length + 1 : 0)}
                      </Text>
                      {file.binary ? (
                        <Text style={[styles.fileStat, { color: theme.colors.textMuted }]}>binary</Text>
                      ) : (
                        <Text style={styles.fileStat}>
                          <Text style={{ color: theme.colors.success }}>+{file.insertions}</Text>{' '}
                          <Text style={{ color: theme.colors.danger }}>-{file.deletions}</Text>
                        </Text>
                      )}
                    </TouchableOpacity>
                  ))}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48 },
  back: { paddingHorizontal: 16, paddingVertical: 12 },
  backText: { ...TEXT_METRICS },
  path: { flex: 1, fontFamily: 'monospace', marginRight: 16, ...TEXT_METRICS },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  vertical: { flex: 1 },
  content: { padding: 16, alignItems: 'stretch' },
  dirRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, marginTop: 4 },
  dirLabel: { fontFamily: 'monospace', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  fileRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, paddingLeft: 8 },
  filePath: { fontFamily: 'monospace', flex: 1, marginRight: 12 },
  fileStat: { fontFamily: 'monospace' },
});
