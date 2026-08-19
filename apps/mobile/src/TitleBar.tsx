// Custom window title bar for the desktop build. Replaces the OS titlebar: the
// whole bar is a Tauri drag region (drag to move, double-click to maximize);
// interactive controls opt out via NO_DRAG_PROPS. macOS keeps native traffic
// lights (we reserve a left inset); Windows/Linux get the custom min/max/close
// cluster on the right. See src/titlebarChrome.ts for the per-OS decisions.

import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps } from 'react';
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

function TitleBarBtn({
  styles,
  color,
  icon,
  size,
  label,
  onPress,
}: {
  styles: ReturnType<typeof createStyles>;
  color: string;
  icon: ComponentProps<typeof Feather>['name'];
  size: number;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      {...NO_DRAG_PROPS}
      style={styles.btn}
      activeOpacity={0.6}
      hitSlop={HIT}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name={icon} size={size} color={color} />
    </TouchableOpacity>
  );
}

function TitleBarWinControls({
  styles,
  color,
  maximized,
}: {
  styles: ReturnType<typeof createStyles>;
  color: string;
  maximized: boolean;
}) {
  return (
    <View style={styles.winControls}>
      <TouchableOpacity
        {...NO_DRAG_PROPS}
        style={styles.winBtn}
        activeOpacity={0.6}
        onPress={() => void minimizeWindow()}
        accessibilityRole="button"
        accessibilityLabel="Minimize"
      >
        <Feather name="minus" size={18} color={color} />
      </TouchableOpacity>
      <TouchableOpacity
        {...NO_DRAG_PROPS}
        style={styles.winBtn}
        activeOpacity={0.6}
        onPress={() => void toggleMaximizeWindow()}
        accessibilityRole="button"
        accessibilityLabel={maximized ? 'Restore' : 'Maximize'}
      >
        <Feather name={maximized ? 'copy' : 'square'} size={15} color={color} />
      </TouchableOpacity>
      <TouchableOpacity
        {...NO_DRAG_PROPS}
        style={[styles.winBtn, styles.winClose]}
        activeOpacity={0.6}
        onPress={() => void closeWindow()}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Feather name="x" size={18} color={color} />
      </TouchableOpacity>
    </View>
  );
}

function TitleBarActions({
  styles,
  colors,
  compact,
  status,
  onNew,
  onChanges,
  changesLabel,
  onSettings,
  onMenu,
  showControls,
  maximized,
}: {
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
  compact: boolean;
  status: TitleBarProps['status'];
  onNew?: () => void;
  onChanges?: () => void;
  changesLabel: string | null;
  onSettings?: () => void;
  onMenu?: () => void;
  showControls: boolean;
  maximized: boolean;
}) {
  return (
    <View style={styles.actions}>
      {!compact && status ? <StatusBadge status={status} colors={colors} /> : null}
      {!compact && onNew ? (
        <TitleBarBtn
          styles={styles}
          color={colors.text}
          icon="plus"
          size={19}
          label="New terminal"
          onPress={onNew}
        />
      ) : null}
      {!compact && onChanges && changesLabel ? (
        <TitleBarBtn
          styles={styles}
          color={colors.accent}
          icon="git-pull-request"
          size={18}
          label={changesLabel}
          onPress={onChanges}
        />
      ) : null}
      {!compact && onSettings ? (
        <TitleBarBtn
          styles={styles}
          color={colors.text}
          icon="settings"
          size={18}
          label="Settings"
          onPress={onSettings}
        />
      ) : null}
      {!compact && onMenu ? (
        <TitleBarBtn
          styles={styles}
          color={colors.text}
          icon="more-vertical"
          size={19}
          label="Terminal menu"
          onPress={onMenu}
        />
      ) : null}
      {showControls ? (
        <TitleBarWinControls styles={styles} color={colors.text} maximized={maximized} />
      ) : null}
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
        <TitleBarBtn
          styles={styles}
          color={theme.colors.text}
          icon="menu"
          size={18}
          label="Open terminal list"
          onPress={onOpenDrawer}
        />
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
      <TitleBarActions
        styles={styles}
        colors={theme.colors}
        compact={compact}
        status={status}
        onNew={onNew}
        onChanges={onChanges}
        changesLabel={changesLabel}
        onSettings={onSettings}
        onMenu={onMenu}
        showControls={showControls}
        maximized={maximized}
      />
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
