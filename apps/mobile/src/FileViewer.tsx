import { useLayoutEffect, useRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { CodeHighlight } from './CodeHighlight';
import { type FileView, lineOffset } from './fileView';
import { PanelHeader } from './PanelHeader';

export function FileViewer({
  file,
  onBack,
  backLabel = 'Back to terminal',
}: {
  file: FileView;
  onBack: () => void;
  backLabel?: string;
}) {
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
      <PanelHeader onBack={onBack} backAccessibilityLabel={backLabel} title={file.path} />
      <ScrollView ref={scrollRef} style={styles.vertical} contentContainerStyle={styles.content}>
        {/* ponytail: the server caps files at 1 MiB; use a virtualized measured list only if profiling shows row rendering jank. */}
        <CodeHighlight path={file.path} code={file.content} onLineLayout={onLineLayout} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  vertical: { flex: 1 },
  content: { padding: 16, alignItems: 'stretch' },
});
