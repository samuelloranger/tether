import { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { lineOffset, type FileView } from './fileView';

const lineHeight = 20;

export function FileViewer({ file, onBack }: { file: FileView; onBack: () => void }) {
  const { theme } = useAppTheme();
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: lineOffset(file.content, file.line) * lineHeight, animated: false });
  }, [file.content, file.line]);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to terminal" onPress={onBack} style={styles.back}>
          <Text style={{ color: theme.colors.accent }}>Back</Text>
        </TouchableOpacity>
        <Text numberOfLines={1} style={[styles.path, { color: theme.colors.text }]}>{file.path}</Text>
      </View>
      <ScrollView ref={scrollRef} style={styles.vertical} contentContainerStyle={styles.content}>
        <ScrollView horizontal contentContainerStyle={styles.horizontal}>
          <Text selectable style={[styles.code, { color: theme.terminal.fg }]}>{file.content}</Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48 },
  back: { paddingHorizontal: 16, paddingVertical: 12 },
  path: { flex: 1, fontFamily: 'monospace', marginRight: 16 },
  vertical: { flex: 1 },
  content: { padding: 16 },
  horizontal: { minWidth: '100%' },
  code: { fontFamily: 'monospace', fontSize: 14, lineHeight },
});
