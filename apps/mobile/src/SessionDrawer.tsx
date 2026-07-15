import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Pressable,
  Animated,
  AccessibilityInfo,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { confirmAction } from './dialog';
import { isRecentlyActive, PANEL_W } from './desktopNavigation';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';

export interface DrawerSession {
  id: string;
  status: 'running' | 'stopped';
  last_output_at: string | null;
  name?: string | null;
}

interface SessionDrawerProps {
  visible: boolean;
  sessions: DrawerSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  onClose: () => void;
  onSettings: () => void;
  // Desktop: render as a permanent inline sidebar (no scrim, no slide, always
  // mounted) instead of a slide-in overlay.
  docked?: boolean;
}

const HIT = { top: 8, bottom: 8, left: 8, right: 8 };

// Kill needs a confirm. confirmAction shows a native OS dialog on desktop (the
// Tauri plugin — not window.confirm, which WebKitGTK titles "JavaScript") and
// the styled multi-button Alert on mobile.
function confirmKill(id: string, onKill: (id: string) => void) {
  void confirmAction(
    'Kill this terminal?',
    "The process and its saved output will be deleted. This can't be undone.",
    { confirmLabel: 'Kill', destructive: true }
  ).then((ok) => {
    if (ok) onKill(id);
  });
}

export function SessionDrawer({
  visible,
  sessions,
  activeId,
  onSelect,
  onNew,
  onKill,
  onClose,
  onSettings,
  docked = false,
}: SessionDrawerProps) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  const [mounted, setMounted] = useState(visible);
  const reduceMotion = useRef(false);
  const tx = useRef(new Animated.Value(visible ? 0 : -PANEL_W)).current;
  const fade = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then((r) => {
        reduceMotion.current = r;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Slide the panel in from the left + fade the scrim; exit is quicker than
    // enter (feels responsive). Reduced-motion snaps without animating.
    if (visible) {
      setMounted(true);
      if (reduceMotion.current) {
        tx.setValue(0);
        fade.setValue(1);
        return;
      }
      Animated.parallel([
        Animated.timing(tx, { toValue: 0, duration: 240, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      if (reduceMotion.current) {
        setMounted(false);
        return;
      }
      Animated.parallel([
        Animated.timing(tx, { toValue: -PANEL_W, duration: 160, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible]);

  const panelBody = (
    <>
      <View style={styles.header}>
          <Feather name="terminal" size={14} color={theme.colors.accent} />
          <Text style={styles.title}>Terminals</Text>
          <TouchableOpacity
            style={styles.settingsBtn}
            hitSlop={HIT}
            activeOpacity={0.6}
            onPress={onSettings}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Feather name="settings" size={15} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {sessions.map((s) => {
            const active = s.id === activeId;
            const live = active || isRecentlyActive(s.last_output_at);
            const dotColor = s.status === 'stopped' ? theme.colors.textFaint : live ? theme.colors.success : theme.colors.border;
            return (
              <View key={s.id} style={[styles.row, active && styles.rowActive]}>
                <TouchableOpacity
                  style={styles.rowMain}
                  activeOpacity={0.6}
                  onPress={() => onSelect(s.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`Terminal ${s.id}${s.status === 'stopped' ? ', stopped' : live ? ', active' : ', idle'}`}
                >
                  <View style={[styles.dot, { backgroundColor: dotColor }]} />
                  <Text style={[styles.name, active && styles.nameActive]}>{s.name || s.id}</Text>
                  {s.status === 'stopped' && <Text style={styles.stopped}>stopped</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.kill}
                  hitSlop={HIT}
                  activeOpacity={0.6}
                  onPress={() => confirmKill(s.id, onKill)}
                  accessibilityRole="button"
                  accessibilityLabel={`Kill terminal ${s.id}`}
                >
                  <Feather name="x" size={16} color={theme.colors.danger} />
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>

        <TouchableOpacity
          style={styles.newBtn}
          activeOpacity={0.8}
          onPress={onNew}
          accessibilityRole="button"
          accessibilityLabel="New terminal"
        >
          <Feather name="plus" size={16} color={theme.colors.accentText} />
          <Text style={styles.newBtnText}>New terminal</Text>
        </TouchableOpacity>
    </>
  );

  // Desktop: a fixed inline column, always present.
  if (docked) {
    return <View style={[styles.panel, styles.panelDocked]}>{panelBody}</View>;
  }

  if (!mounted) return null;

  // Mobile: slide-in overlay with a tap-to-dismiss scrim.
  return (
    <View style={styles.overlay}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
        <Pressable
          style={styles.scrim}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close terminal list"
        />
      </Animated.View>

      <Animated.View style={[styles.panel, { transform: [{ translateX: tx }] }]}>
        {panelBody}
      </Animated.View>
    </View>
  );
}

const createStyles = (c: AppColors) => StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
  scrim: { flex: 1, backgroundColor: c.overlay },
  panel: {
    width: PANEL_W,
    backgroundColor: c.surface,
    borderRightWidth: 1,
    borderRightColor: c.border,
    paddingTop: 56,
    paddingHorizontal: 12,
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
  },
  // Docked (desktop): inline column, no absolute positioning, tighter top pad
  // (no mobile status bar to clear).
  panelDocked: { position: 'relative', paddingTop: 12, alignSelf: 'stretch' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  settingsBtn: { marginLeft: 'auto', padding: 4 },
  title: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    marginBottom: 4,
    minHeight: 44,
    backgroundColor: c.surfaceRaised,
  },
  rowActive: { backgroundColor: c.selected },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 11 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  name: { color: c.text, fontFamily: 'Courier', fontSize: 13 },
  nameActive: { color: c.accent, fontWeight: '700' },
  stopped: { color: c.textFaint, fontSize: 10, marginLeft: 8 },
  kill: { paddingHorizontal: 12, paddingVertical: 11, alignItems: 'center', justifyContent: 'center' },
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginVertical: 12,
    paddingVertical: 13,
    borderRadius: 8,
    backgroundColor: c.accent,
  },
  newBtnText: { color: c.accentText, fontWeight: '600', fontSize: 13 },
});
