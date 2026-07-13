// Custom window title bar for the desktop build. Replaces the OS titlebar: the
// whole bar is a Tauri drag region (drag to move, double-click to maximize);
// interactive controls opt out via NO_DRAG_PROPS. macOS keeps native traffic
// lights (we reserve a left inset); Windows/Linux get the custom min/max/close
// cluster on the right. See src/titlebarChrome.ts for the per-OS decisions.
import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { titlebarChrome } from './titlebarChrome';
import { DRAG_PROPS, NO_DRAG_PROPS } from './dragRegion';
import {
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  onMaximizeChange,
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
  onSettings?: () => void;
  onMenu?: () => void;
}

const HIT = { top: 8, bottom: 8, left: 6, right: 6 };

function StatusBadge({ status }: { status: TitleBarProps['status'] }) {
  if (status === 'connected') {
    return (
      <View style={[styles.badge, styles.badgeOk]}>
        <View style={[styles.dot, styles.dotOk]} />
        <Text style={styles.badgeTextOk}>Connected</Text>
      </View>
    );
  }
  if (status === 'connecting') {
    return (
      <View style={[styles.badge, styles.badgeWarn]}>
        <ActivityIndicator size={8} color="#fbbf24" style={{ marginRight: 5 }} />
        <Text style={styles.badgeTextWarn}>Connecting…</Text>
      </View>
    );
  }
  const label = status === 'auth-failed' ? 'Auth' : 'Offline';
  return (
    <View style={[styles.badge, styles.badgeOff]}>
      <View style={[styles.dot, styles.dotOff]} />
      <Text style={styles.badgeTextOff}>{label}</Text>
    </View>
  );
}

export default function TitleBar({
  isMac,
  title,
  subtitle,
  status,
  onNew,
  onSettings,
  onMenu,
}: TitleBarProps) {
  const { showControls, leftInset } = titlebarChrome(isMac);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!showControls) return;
    let unlisten: (() => void) | undefined;
    onMaximizeChange(setMaximized).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [showControls]);

  return (
    <View style={styles.bar} {...DRAG_PROPS}>
      {leftInset > 0 && <View style={{ width: leftInset }} />}

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
        {status ? <StatusBadge status={status} /> : null}

        {onNew ? (
          <TouchableOpacity
            {...NO_DRAG_PROPS}
            style={styles.btn}
            activeOpacity={0.6}
            hitSlop={HIT}
            onPress={onNew}
            accessibilityRole="button"
            accessibilityLabel="New terminal"
          >
            <Feather name="plus" size={19} color="#cbd5e1" />
          </TouchableOpacity>
        ) : null}

        {onSettings ? (
          <TouchableOpacity
            {...NO_DRAG_PROPS}
            style={styles.btn}
            activeOpacity={0.6}
            hitSlop={HIT}
            onPress={onSettings}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Feather name="settings" size={18} color="#cbd5e1" />
          </TouchableOpacity>
        ) : null}

        {onMenu ? (
          <TouchableOpacity
            {...NO_DRAG_PROPS}
            style={styles.btn}
            activeOpacity={0.6}
            hitSlop={HIT}
            onPress={onMenu}
            accessibilityRole="button"
            accessibilityLabel="Terminal menu"
          >
            <Feather name="more-vertical" size={19} color="#cbd5e1" />
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
              <Feather name="minus" size={18} color="#cbd5e1" />
            </TouchableOpacity>
            <TouchableOpacity
              {...NO_DRAG_PROPS}
              style={styles.winBtn}
              activeOpacity={0.6}
              onPress={() => void toggleMaximizeWindow()}
              accessibilityRole="button"
              accessibilityLabel={maximized ? 'Restore' : 'Maximize'}
            >
              <Feather name={maximized ? 'copy' : 'square'} size={15} color="#cbd5e1" />
            </TouchableOpacity>
            <TouchableOpacity
              {...NO_DRAG_PROPS}
              style={[styles.winBtn, styles.winClose]}
              activeOpacity={0.6}
              onPress={() => void closeWindow()}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Feather name="x" size={18} color="#cbd5e1" />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    paddingLeft: 12,
    backgroundColor: '#0b0f19',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  info: { flex: 1, minWidth: 0 },
  title: { color: '#e2e8f0', fontSize: 13, fontWeight: '600' },
  subtitle: { color: '#64748b', fontSize: 11 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  btn: { paddingHorizontal: 8, paddingVertical: 6 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginRight: 4,
  },
  badgeOk: { backgroundColor: 'rgba(34,197,94,0.12)' },
  badgeWarn: { backgroundColor: 'rgba(251,191,36,0.12)' },
  badgeOff: { backgroundColor: 'rgba(148,163,184,0.12)' },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 5 },
  dotOk: { backgroundColor: '#22c55e' },
  dotOff: { backgroundColor: '#94a3b8' },
  badgeTextOk: { color: '#22c55e', fontSize: 11, fontWeight: '600' },
  badgeTextWarn: { color: '#fbbf24', fontSize: 11, fontWeight: '600' },
  badgeTextOff: { color: '#94a3b8', fontSize: 11, fontWeight: '600' },
  winControls: { flexDirection: 'row', alignItems: 'center', marginLeft: 6 },
  winBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  winClose: {},
});
