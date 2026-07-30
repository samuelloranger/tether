import type { StyleProp, ViewStyle } from 'react-native';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { canCommit } from './gitReviewModel';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';

export function CommitBox({
  message,
  onChangeMessage,
  onCommit,
  stagedCount,
  committing,
  style,
}: {
  message: string;
  onChangeMessage: (value: string) => void;
  onCommit: () => void;
  stagedCount: number;
  committing: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useAppTheme();
  const enabled = canCommit(stagedCount, message, committing);

  return (
    <View style={[styles.commitBar, { borderTopColor: theme.colors.border }, style]}>
      <TextInput
        style={[
          styles.commitInput,
          {
            color: theme.colors.text,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface,
          },
        ]}
        placeholder="Commit message"
        placeholderTextColor={theme.colors.textFaint}
        value={message}
        onChangeText={onChangeMessage}
        editable={!committing}
        multiline
      />
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Commit staged changes"
        disabled={!enabled}
        onPress={onCommit}
        style={[
          styles.commitButton,
          {
            backgroundColor: theme.colors.accent,
            opacity: enabled ? 1 : 0.5,
          },
        ]}
      >
        {committing ? (
          <ActivityIndicator color={theme.colors.accentText} size="small" />
        ) : (
          <Text style={[styles.commitButtonText, { color: theme.colors.accentText }]}>Commit</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  commitBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  commitInput: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: SURFACE_RADIUS.control,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 96,
    fontSize: 14,
  },
  commitButton: {
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: SURFACE_RADIUS.control,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commitButtonText: { fontWeight: '600' },
});
