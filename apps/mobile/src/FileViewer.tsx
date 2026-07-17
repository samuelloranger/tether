import { useLayoutEffect, useRef } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { lineOffset, type FileView } from './fileView';
import { CodeHighlight } from './CodeHighlight';

const TEXT_METRICS = { lineHeight: 20, includeFontPadding: false } as const;

export function FileViewer({ file, onBack }: { file: FileView; onBack: () => void }) {
  const { theme } = useAppTheme();
  const scrollRef = useRef<ScrollView>(null);
  const rowOffsets = useRef(new Map<number, number>());
  const pendingTargetLine = useRef(0);

  useLayoutEffect(() => {
    rowOffsets.current.clear();
  }, [file.path, file.content]);

  useLayoutEffect(() => {
    const target = lineOffset(file.content, file.line);
    pendingTargetLine.current = target;
    const y = rowOffsets.current.get(target);
    if (y !== undefined) {
      scrollRef.current?.scrollTo({ y, animated: false });
      pendingTargetLine.current = -1;
    }
  }, [file.path, file.content, file.line]);

  const onLineLayout = (index: number, y: number) => {
    rowOffsets.current.set(index, y);
    if (pendingTargetLine.current !== index) return;
    scrollRef.current?.scrollTo({ y, animated: false });
    pendingTargetLine.current = -1;
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to terminal" onPress={onBack} style={styles.back}>
          <Text style={[styles.backText, { color: theme.colors.accent }]}>Back</Text>
        </TouchableOpacity>
        <Text numberOfLines={1} style={[styles.path, { color: theme.colors.text }]}>{file.path}</Text>
      </View>
      <ScrollView ref={scrollRef} style={styles.vertical} contentContainerStyle={styles.content}>
        {/* ponytail: the server caps files at 1 MiB; use a virtualized measured list only if profiling shows row rendering jank. */}
        <CodeHighlight path={file.path} code={file.content} onLineLayout={onLineLayout} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48 },
  back: { paddingHorizontal: 16, paddingVertical: 12 },
  backText: { ...TEXT_METRICS },
  path: { flex: 1, fontFamily: 'monospace', marginRight: 16, ...TEXT_METRICS },
  vertical: { flex: 1 },
  content: { padding: 16, alignItems: 'stretch' },
});
