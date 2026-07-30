import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { DiffLines } from './DiffLines';
import { displayDiff } from './diffModel';
import { ImageDiff } from './ImageDiff';
import { MIN_TOUCH_TARGET } from './interaction';
import { SideBySideDiff } from './SideBySideDiff';

export function DiffFileBody({
  loading,
  error,
  path,
  diffText,
  truncated,
  image,
  sideBySide,
  wideEnough,
  onHunkPress,
  hunkActionLabel,
  onRetry,
}: {
  loading: boolean;
  error?: string | null;
  path: string;
  diffText: string | null;
  truncated: boolean;
  image?: { old: string | null; new: string | null } | null;
  sideBySide: boolean;
  wideEnough: boolean;
  onHunkPress?: (hunkIndex: number) => void;
  hunkActionLabel?: string;
  onRetry?: () => void;
}) {
  const { theme } = useAppTheme();

  if (loading) {
    return (
      <View style={styles.center} accessibilityRole="progressbar">
        <ActivityIndicator color={theme.colors.accent} testID="diff-file-loading" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={{ color: theme.colors.text, marginBottom: 12 }}>{error}</Text>
        {onRetry ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Retry loading diff"
            onPress={onRetry}
            style={styles.retry}
          >
            <Text style={{ color: theme.colors.accent, fontWeight: '600' }}>Retry</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  if (image) {
    return <ImageDiff oldUri={image.old} newUri={image.new} loading={false} />;
  }

  const text = displayDiff(diffText ?? '', truncated);
  if (sideBySide && wideEnough) {
    return (
      <ScrollView style={styles.vertical} contentContainerStyle={styles.content}>
        <SideBySideDiff diffText={text} path={path} />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.vertical} contentContainerStyle={styles.content}>
      <DiffLines
        diffText={text}
        path={path}
        onHunkPress={onHunkPress}
        hunkActionLabel={hunkActionLabel}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  vertical: { flex: 1 },
  content: { padding: 16, alignItems: 'stretch' },
  retry: {
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
