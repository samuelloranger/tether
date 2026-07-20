import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { buildFileTree, displayDiff, isImagePath, type DiffSummary } from './diffModel';
import { DiffLines } from './DiffLines';
import { FileTree } from './FileTree';
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
          <FileTree
            nodes={buildFileTree(summary.files)}
            collapsedDirs={collapsedDirs}
            onToggleDir={toggleDir}
            onSelectFile={onSelectFile}
          />
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
});
