import Feather from '@expo/vector-icons/Feather';
import { useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  ActivityIndicator,
  Modal,
  Pressable,
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
  onAmend,
  onUndoCommit,
  onPush,
  canAmend,
  canPush,
  stagedCount,
  committing,
  style,
}: {
  message: string;
  onChangeMessage: (value: string) => void;
  onCommit: () => void;
  onAmend?: () => void;
  onUndoCommit?: () => void;
  onPush?: () => void;
  canAmend?: boolean;
  canPush?: boolean;
  stagedCount: number;
  committing: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useAppTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const enabled = canCommit(stagedCount, message, committing);
  const amendEnabled = Boolean(canAmend) && message.trim().length > 0 && !committing;
  const undoEnabled = Boolean(canAmend) && !committing;
  const pushEnabled = Boolean(canPush) && !committing;
  const hasMenu =
    Boolean(onAmend || onUndoCommit || onPush) &&
    (Boolean(canAmend) || Boolean(canPush) || Boolean(onPush));

  const runAndClose = (action?: () => void) => {
    setMenuOpen(false);
    action?.();
  };

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
      <View style={styles.commitGroup}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Commit staged changes"
          disabled={!enabled}
          onPress={onCommit}
          style={[
            styles.commitButton,
            hasMenu ? styles.commitButtonMain : null,
            {
              backgroundColor: theme.colors.accent,
              opacity: enabled ? 1 : 0.5,
            },
          ]}
        >
          {committing ? (
            <ActivityIndicator color={theme.colors.accentText} size="small" />
          ) : (
            <Text style={[styles.commitButtonText, { color: theme.colors.accentText }]}>
              Commit
            </Text>
          )}
        </TouchableOpacity>
        {hasMenu ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="More git actions"
            disabled={committing}
            onPress={() => setMenuOpen(true)}
            style={[
              styles.chevronButton,
              {
                backgroundColor: theme.colors.accent,
                borderLeftColor: theme.colors.accentText,
                opacity: committing ? 0.5 : 1,
              },
            ]}
          >
            <Feather name="chevron-down" size={16} color={theme.colors.accentText} />
          </TouchableOpacity>
        ) : null}
      </View>

      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)}>
          <View
            style={[
              styles.menu,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
              },
            ]}
          >
            {onAmend && canAmend ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Amend last commit"
                disabled={!amendEnabled}
                onPress={() => runAndClose(onAmend)}
                style={[styles.menuRow, { opacity: amendEnabled ? 1 : 0.45 }]}
              >
                <Feather name="edit-2" size={15} color={theme.colors.text} />
                <Text style={[styles.menuText, { color: theme.colors.text }]}>Amend</Text>
              </TouchableOpacity>
            ) : null}
            {onUndoCommit && canAmend ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Undo last commit"
                disabled={!undoEnabled}
                onPress={() => runAndClose(onUndoCommit)}
                style={[styles.menuRow, { opacity: undoEnabled ? 1 : 0.45 }]}
              >
                <Feather name="rotate-ccw" size={15} color={theme.colors.text} />
                <Text style={[styles.menuText, { color: theme.colors.text }]}>
                  Undo last commit
                </Text>
              </TouchableOpacity>
            ) : null}
            {onPush ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Push to remote"
                disabled={!pushEnabled}
                onPress={() => runAndClose(onPush)}
                style={[styles.menuRow, { opacity: pushEnabled ? 1 : 0.45 }]}
              >
                <Feather name="upload-cloud" size={15} color={theme.colors.text} />
                <Text style={[styles.menuText, { color: theme.colors.text }]}>Push</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </Pressable>
      </Modal>
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
  commitGroup: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: SURFACE_RADIUS.control,
    overflow: 'hidden',
  },
  commitButton: {
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commitButtonMain: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
  },
  chevronButton: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: 36,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  commitButtonText: { fontWeight: '600' },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
    justifyContent: 'flex-end',
    padding: 16,
  },
  menu: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: SURFACE_RADIUS.panel,
    paddingVertical: 4,
    alignSelf: 'flex-end',
    minWidth: 200,
    marginBottom: 64,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: 14,
  },
  menuText: { fontSize: 14, fontWeight: '500' },
});
