// Custom window title bar for the desktop build. Replaces the OS titlebar: the
// whole bar is a Tauri drag region (drag to move, double-click to maximize);
// interactive controls opt out via NO_DRAG_PROPS. macOS keeps native traffic
// lights (we reserve a left inset); Windows/Linux get the custom min/max/close
// cluster on the right. See src/titlebarChrome.ts for the per-OS decisions.

import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { changeBannerLabel, type DiffSummary } from './diffModel';
import { DRAG_PROPS, NO_DRAG_PROPS } from './dragRegion';
import { titlebarChrome } from './titlebarChrome';
import {
  closeWindow,
  minimizeWindow,
  onFullscreenChange,
  onMaximizeChange,
  toggleMaximizeWindow,
} from './windowControls';
export interface TitleBarProps {
  isMac: boolean;
  title: string;
  // Session-specific chrome — omitted on the config screen, which renders the bar
  // only for the drag region + window controls (so a frameless window still has
  // close/min/max and is movable before any session exists).
  subtitle?: string;
  status?: 'connected' | 'connecting' | 'auth-failed' | 'offline';
  onNew?: () => void;
  onChanges?: () => void;
  changeSummary?: DiffSummary;
  onSettings?: () => void;
  onMenu?: () => void;
  // When set, shows a left hamburger that opens the session drawer (unpinned
  // wide desktop). Same accessibility label as the mobile header control.
  onOpenDrawer?: () => void;
  // Compact desktop windows keep their window-management chrome, while the
  // mobile header below owns terminal actions and connection state.
  compact?: boolean;
}

const HIT = { top: 8, bottom: 8, left: 6, right: 6 };
const COMPACT_TEXT = { includeFontPadding: false } as const;

function StatusBadge({ status, colors }: { status: TitleBarProps['status']; colors: AppColors }) {
  const styles = createStyles(colors);
  if (status === 'connected') {
    return (
      <View style={styles.statusWord}>
        <Text style={styles.statusWordOk}>online</Text>
      </View>
    );
  }
  if (status === 'connecting') {
    return (
      <View style={styles.statusWord}>
        <ActivityIndicator size={8} color={colors.warning} style={{ marginRight: 5 }} />
        <Text style={styles.statusWordWarn}>connecting</Text>
      </View>
    );
  }
  const label = status === 'auth-failed' ? 'auth' : 'offline';
  return (
    <View style={styles.statusWord}>
      <Text style={styles.statusWordOff}>{label}</Text>
    </View>
  );
}

export default function TitleBar({
  isMac,
  title,
  subtitle,
  status,
  onNew,
  onChanges,
  changeSummary,
  onSettings,
  onMenu,
  onOpenDrawer,
  compact = false,
}: TitleBarProps) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const { showControls, leftInset } = titlebarChrome(isMac, fullscreen);
  const changesLabel = changeSummary ? changeBannerLabel(changeSummary) : null;

  useEffect(() => {
    if (!showControls) return;
    let unlisten: (() => void) | undefined;
    onMaximizeChange(setMaximized).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [showControls]);

  // macOS: the native traffic lights hide in fullscreen, so collapse the inset.
  // (This runs even though showControls is false on macOS.)
  useEffect(() => {
    if (!isMac) return;
    let unlisten: (() => void) | undefined;
    onFullscreenChange(setFullscreen).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [isMac]);

  return (
    <View style={styles.bar} {...DRAG_PROPS}>
      {leftInset > 0 && <View style={{ width: leftInset }} />}

      {onOpenDrawer ? (
        <TouchableOpacity
          {...NO_DRAG_PROPS}
          style={styles.btn}
          activeOpacity={0.6}
          hitSlop={HIT}
          onPress={onOpenDrawer}
          accessibilityRole="button"
          accessibilityLabel="Open terminal list"
        >
          <Feather name="menu" size={18} color={theme.colors.text} />
        </TouchableOpacity>
      ) : null}

      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        {!compact && status ? <StatusBadge status={status} colors={theme.colors} /> : null}

        {!compact && onNew ? (
          <TouchableOpacity
            {...NO_DRAG_PROPS}
            style={styles.btn}
            activeOpacity={0.6}
            hitSlop={HIT}
            onPress={onNew}
            accessibilityRole="button"
            accessibilityLabel="New terminal"
          >
            <Feather name="plus" size={19} color={theme.colors.text} />
          </TouchableOpacity>
        ) : null}

        {!compact && onChanges && changesLabel ? (
          <TouchableOpacity
            {...NO_DRAG_PROPS}
            style={styles.btn}
            activeOpacity={0.6}
            hitSlop={HIT}
            onPress={onChanges}
            accessibilityRole="button"
            accessibilityLabel={changesLabel}
          >
            <Feather name="git-pull-request" size={18} color={theme.colors.accent} />
          </TouchableOpacity>
        ) : null}

        {!compact && onSettings ? (
          <TouchableOpacity
            {...NO_DRAG_PROPS}
            style={styles.btn}
            activeOpacity={0.6}
            hitSlop={HIT}
            onPress={onSettings}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Feather name="settings" size={18} color={theme.colors.text} />
          </TouchableOpacity>
        ) : null}

        {!compact && onMenu ? (
          <TouchableOpacity
            {...NO_DRAG_PROPS}
            style={styles.btn}
            activeOpacity={0.6}
            hitSlop={HIT}
            onPress={onMenu}
            accessibilityRole="button"
            accessibilityLabel="Terminal menu"
          >
            <Feather name="more-vertical" size={19} color={theme.colors.text} />
          </TouchableOpacity>
        ) : null}

        {showControls && (
          <View style={styles.winControls}>
            <TouchableOpacity
              {...NO_DRAG_PROPS}
              style={styles.winBtn}
              activeOpacity={0.6}
              onPress={() => void minimizeWindow()}
              accessibilityRole="button"
              accessibilityLabel="Minimize"
            >
              <Feather name="minus" size={18} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              {...NO_DRAG_PROPS}
              style={styles.winBtn}
              activeOpacity={0.6}
              onPress={() => void toggleMaximizeWindow()}
              accessibilityRole="button"
              accessibilityLabel={maximized ? 'Restore' : 'Maximize'}
            >
              <Feather name={maximized ? 'copy' : 'square'} size={15} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              {...NO_DRAG_PROPS}
              style={[styles.winBtn, styles.winClose]}
              activeOpacity={0.6}
              onPress={() => void closeWindow()}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Feather name="x" size={18} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const createStyles = (c: AppColors) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 40,
      paddingLeft: 12,
      backgroundColor: c.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    info: { flex: 1, minWidth: 0 },
    title: { color: c.text, fontSize: 13, lineHeight: 15, fontWeight: '600', ...COMPACT_TEXT },
    subtitle: { color: c.textFaint, fontSize: 11, lineHeight: 13, ...COMPACT_TEXT },
    actions: { flexDirection: 'row', alignItems: 'center' },
    btn: { paddingHorizontal: 8, paddingVertical: 6 },
    statusWord: {
      flexDirection: 'row',
      alignItems: 'center',
      marginRight: 6,
      paddingLeft: 10,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: c.border,
    },
    statusWordOk: {
      color: c.success,
      fontSize: 11,
      lineHeight: 13,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
      ...COMPACT_TEXT,
    },
    statusWordWarn: {
      color: c.warning,
      fontSize: 11,
      lineHeight: 13,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
      ...COMPACT_TEXT,
    },
    statusWordOff: {
      color: c.textMuted,
      fontSize: 11,
      lineHeight: 13,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
      ...COMPACT_TEXT,
    },
    winControls: { flexDirection: 'row', alignItems: 'center', marginLeft: 6 },
    winBtn: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    winClose: {},
  });
