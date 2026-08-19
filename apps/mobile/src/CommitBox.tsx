import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  ActivityIndicator,
  Alert,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { MENU_WIDTH } from './commitBoxLayout';
import { canCommit } from './gitReviewModel';
import { minTouchTarget, SURFACE_RADIUS } from './interaction';

const TOUCH_TARGET = minTouchTarget();

type ThemeColors = {
  text: string;
  textFaint: string;
  accent: string;
  accentText: string;
  border: string;
  surface: string;
};

function openMoreMenu(opts: {
  useDropdownMenu: boolean;
  setMenuOpen: (update: boolean | ((open: boolean) => boolean)) => void;
  onAmend?: () => void;
  onUndoCommit?: () => void;
  onPush?: () => void;
  amendEnabled: boolean;
  undoEnabled: boolean;
  pushEnabled: boolean;
}) {
  if (opts.useDropdownMenu) {
    opts.setMenuOpen((open) => !open);
    return;
  }
  const buttons: {
    text: string;
    onPress?: () => void;
    style?: 'cancel' | 'destructive' | 'default';
  }[] = [];
  if (opts.onAmend && opts.amendEnabled) buttons.push({ text: 'Amend', onPress: opts.onAmend });
  if (opts.onUndoCommit && opts.undoEnabled) {
    buttons.push({ text: 'Undo last commit', onPress: opts.onUndoCommit, style: 'destructive' });
  }
  if (opts.onPush && opts.pushEnabled) buttons.push({ text: 'Push', onPress: opts.onPush });
  buttons.push({ text: 'Cancel', style: 'cancel' });
  Alert.alert('More git actions', undefined, buttons);
}

function CommitMenuItem({
  text,
  accessibilityLabel,
  icon,
  enabled,
  onPress,
  color,
}: {
  text: string;
  accessibilityLabel: string;
  icon: 'edit-2' | 'rotate-ccw' | 'upload-cloud';
  enabled: boolean;
  onPress: () => void;
  color: string;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={!enabled}
      onPress={onPress}
      style={[styles.menuRow, { opacity: enabled ? 1 : 0.45 }]}
    >
      <Feather name={icon} size={15} color={color} />
      <Text style={[styles.menuText, { color }]}>{text}</Text>
    </TouchableOpacity>
  );
}

function CommitDropdown({
  menuPlacement,
  colors,
  onAmend,
  onUndoCommit,
  onPush,
  amendEnabled,
  undoEnabled,
  pushEnabled,
  runAndClose,
}: {
  menuPlacement: 'up' | 'down';
  colors: ThemeColors;
  onAmend?: () => void;
  onUndoCommit?: () => void;
  onPush?: () => void;
  amendEnabled: boolean;
  undoEnabled: boolean;
  pushEnabled: boolean;
  runAndClose: (action?: () => void) => void;
}) {
  return (
    <View
      accessibilityRole="menu"
      style={[
        styles.menu,
        menuPlacement === 'down' ? styles.menuDown : styles.menuUp,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      {onAmend ? (
        <CommitMenuItem
          text="Amend"
          accessibilityLabel="Amend last commit"
          icon="edit-2"
          enabled={amendEnabled}
          onPress={() => runAndClose(onAmend)}
          color={colors.text}
        />
      ) : null}
      {onUndoCommit ? (
        <CommitMenuItem
          text="Undo last commit"
          accessibilityLabel="Undo last commit"
          icon="rotate-ccw"
          enabled={undoEnabled}
          onPress={() => runAndClose(onUndoCommit)}
          color={colors.text}
        />
      ) : null}
      {onPush ? (
        <CommitMenuItem
          text="Push"
          accessibilityLabel="Push to remote"
          icon="upload-cloud"
          enabled={pushEnabled}
          onPress={() => runAndClose(onPush)}
          color={colors.text}
        />
      ) : null}
    </View>
  );
}

function CommitActions({
  colors,
  enabled,
  committing,
  hasMenu,
  menuOpen,
  useDropdownMenu,
  onCommit,
  onOpenMore,
  menuRootRef,
  dropdown,
}: {
  colors: ThemeColors;
  enabled: boolean;
  committing: boolean;
  hasMenu: boolean;
  menuOpen: boolean;
  useDropdownMenu: boolean;
  onCommit: () => void;
  onOpenMore: () => void;
  menuRootRef: React.RefObject<View | null>;
  dropdown: React.ReactNode;
}) {
  return (
    <View style={[styles.commitGroup, menuOpen ? styles.commitGroupRaised : null]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Commit staged changes"
        disabled={!enabled}
        onPress={onCommit}
        style={[
          styles.commitButton,
          hasMenu ? styles.commitButtonMain : styles.commitButtonSolo,
          { backgroundColor: colors.accent, opacity: enabled ? 1 : 0.5 },
        ]}
      >
        {committing ? (
          <ActivityIndicator color={colors.accentText} size="small" />
        ) : (
          <Text style={[styles.commitButtonText, { color: colors.accentText }]}>Commit</Text>
        )}
      </TouchableOpacity>
      {hasMenu ? (
        <View ref={menuRootRef} collapsable={false} style={styles.chevronWrap}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="More git actions"
            disabled={committing}
            onPress={onOpenMore}
            style={[
              styles.chevronButton,
              {
                backgroundColor: colors.accent,
                borderLeftColor: colors.accentText,
                opacity: committing ? 0.5 : 1,
              },
            ]}
          >
            <Feather
              name={menuOpen ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={colors.accentText}
            />
          </TouchableOpacity>
          {useDropdownMenu && menuOpen ? dropdown : null}
        </View>
      ) : null}
    </View>
  );
}

type CommitBoxProps = {
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
  /** GitReview pins the bar at the top — open the menu downward so it stays on-screen. */
  menuPlacement?: 'up' | 'down';
};

function useCommitMenu(useDropdownMenu: boolean) {
  const menuRootRef = useRef<View>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen || !useDropdownMenu || typeof document === 'undefined') return;
    const onDoc = (event: MouseEvent) => {
      const root = menuRootRef.current as unknown as { contains?: (n: Node) => boolean } | null;
      const target = event.target as Node | null;
      if (root?.contains && target && root.contains(target)) return;
      setMenuOpen(false);
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [menuOpen, useDropdownMenu]);
  return { menuRootRef, menuOpen, setMenuOpen };
}

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
  menuPlacement = 'up',
}: CommitBoxProps) {
  const { theme } = useAppTheme();
  const colors = theme.colors;
  const useDropdownMenu = Platform.OS === 'web';
  const { menuRootRef, menuOpen, setMenuOpen } = useCommitMenu(useDropdownMenu);
  const enabled = canCommit(stagedCount, message, committing);
  const amendEnabled = Boolean(canAmend) && message.trim().length > 0 && !committing;
  const undoEnabled = Boolean(canAmend) && !committing;
  const pushEnabled = Boolean(canPush) && !committing;
  const hasMenu = Boolean(onAmend || onUndoCommit || onPush);
  return (
    <View style={[styles.commitBar, { borderTopColor: colors.border }, style]}>
      <TextInput
        accessibilityLabel="Commit message"
        style={[
          styles.commitInput,
          { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface },
        ]}
        placeholder="Commit message"
        placeholderTextColor={colors.textFaint}
        value={message}
        onChangeText={onChangeMessage}
        editable={!committing}
        multiline
      />
      <CommitActions
        colors={colors}
        enabled={enabled}
        committing={committing}
        hasMenu={hasMenu}
        menuOpen={menuOpen}
        useDropdownMenu={useDropdownMenu}
        onCommit={onCommit}
        onOpenMore={() =>
          openMoreMenu({
            useDropdownMenu,
            setMenuOpen,
            onAmend,
            onUndoCommit,
            onPush,
            amendEnabled,
            undoEnabled,
            pushEnabled,
          })
        }
        menuRootRef={menuRootRef}
        dropdown={
          <CommitDropdown
            menuPlacement={menuPlacement}
            colors={colors}
            onAmend={onAmend}
            onUndoCommit={onUndoCommit}
            onPush={onPush}
            amendEnabled={amendEnabled}
            undoEnabled={undoEnabled}
            pushEnabled={pushEnabled}
            runAndClose={(action) => {
              setMenuOpen(false);
              action?.();
            }}
          />
        }
      />
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
    overflow: 'visible',
    zIndex: 2,
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
  },
  commitGroupRaised: {
    zIndex: 20,
  },
  commitButton: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commitButtonSolo: {
    borderRadius: SURFACE_RADIUS.control,
  },
  commitButtonMain: {
    borderTopLeftRadius: SURFACE_RADIUS.control,
    borderBottomLeftRadius: SURFACE_RADIUS.control,
  },
  chevronWrap: {
    position: 'relative',
    zIndex: 21,
  },
  chevronButton: {
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderTopRightRadius: SURFACE_RADIUS.control,
    borderBottomRightRadius: SURFACE_RADIUS.control,
  },
  commitButtonText: { fontWeight: '600' },
  menu: {
    position: 'absolute',
    right: 0,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: SURFACE_RADIUS.panel,
    paddingVertical: 4,
    minWidth: MENU_WIDTH,
    zIndex: 30,
  },
  menuUp: {
    bottom: '100%',
    marginBottom: 6,
  },
  menuDown: {
    top: '100%',
    marginTop: 6,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 14,
  },
  menuText: { fontSize: 14, fontWeight: '500' },
});
