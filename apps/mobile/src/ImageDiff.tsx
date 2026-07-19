import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';

// Side-by-side old/new image compare. When only one side exists (an added or
// deleted file) that single side fills the space instead of leaving a blank
// pane next to it.
export function ImageDiff({
  oldUri,
  newUri,
  loading,
}: {
  oldUri: string | null;
  newUri: string | null;
  loading: boolean;
}) {
  const { theme } = useAppTheme();

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  if (!oldUri && !newUri) {
    return (
      <View style={styles.center}>
        <Text style={{ color: theme.colors.textMuted }}>Preview not available</Text>
      </View>
    );
  }

  const panes = [
    oldUri ? { label: 'Before', uri: oldUri } : null,
    newUri ? { label: 'After', uri: newUri } : null,
  ].filter((pane): pane is { label: string; uri: string } => pane !== null);

  return (
    <View style={styles.root}>
      {panes.map((pane) => (
        <View key={pane.label} style={styles.pane}>
          <Text style={[styles.label, { color: theme.colors.textMuted }]}>{pane.label}</Text>
          <View style={[styles.imageWrap, { backgroundColor: theme.colors.surfaceRaised }]}>
            <Image source={{ uri: pane.uri }} style={styles.image} resizeMode="contain" />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', padding: 16, gap: 16 },
  pane: { flex: 1 },
  label: { fontFamily: 'monospace', fontSize: 12, marginBottom: 8, textTransform: 'uppercase' },
  imageWrap: { flex: 1, borderRadius: 8, overflow: 'hidden' },
  image: { width: '100%', height: '100%', minHeight: 200 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
