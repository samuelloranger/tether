import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from './AppThemeProvider';
import { activityDotKey, type SessionActivity, terminalAccessibilityLabel } from './activity';
import type { AppColors } from './appTheme';
import { isRecentlyActive, PANEL_W } from './desktopNavigation';
import { confirmAction } from './dialog';
import { HIT_SLOP, MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import { motionSpec } from './motion';
import type { Presentation } from './presentations';
import { sessionLabel } from './sessionLabel';
import type { HostHealthStatus } from './tether/hostHealth';
import type { HostProfile } from './tether/hostStore';

export interface DrawerSession {
  hostId: string;
  id: string;
  status: 'running' | 'stopped';
  last_output_at: string | null;
  name?: string | null;
  auto_title?: string | null;
  activity?: SessionActivity | null;
}

interface SessionDrawerProps {
  visible: boolean;
  hosts: HostProfile[];
  healthByHost: Record<string, HostHealthStatus>;
  sessions: DrawerSession[];
  activeHostId: string;
  activeId: string;
  onSelect: (hostId: string, id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  onRetryHost: (hostId: string) => void;
  onReenterPassword: (hostId: string) => void;
  previews: Presentation[];
  activePreviewId: string | null;
  onSelectPreview: (id: string) => void;
  onClosePreview: (id: string) => void;
  onClose: () => void;
  onHostSettings?: (hostId: string) => void;
  // Desktop: render as a permanent inline sidebar (no scrim, no slide, always
  // mounted) instead of a slide-in overlay.
  docked?: boolean;
}

// Kill needs a confirm. confirmAction shows a native OS dialog on desktop (the
// Tauri plugin — not window.confirm, which WebKitGTK titles "JavaScript") and
// the styled multi-button Alert on mobile.
function confirmKill(id: string, onKill: (id: string) => void) {
  void confirmAction(
    'Kill this terminal?',
    "The process and its saved output will be deleted. This can't be undone.",
    { confirmLabel: 'Kill', destructive: true },
  ).then((ok) => {
    if (ok) onKill(id);
  });
}

export function SessionDrawer({
  visible,
  hosts,
  healthByHost,
  sessions,
  activeHostId,
  activeId,
  onSelect,
  onNew,
  onKill,
  onRetryHost,
  onReenterPassword,
  previews,
  activePreviewId,
  onSelectPreview,
  onClosePreview,
  onClose,
  onHostSettings,
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
        Animated.timing(tx, { toValue: 0, ...motionSpec('drawerEnter', false) }),
        Animated.timing(fade, { toValue: 1, ...motionSpec('drawerEnter', false) }),
      ]).start();
    } else if (mounted) {
      if (reduceMotion.current) {
        setMounted(false);
        return;
      }
      Animated.parallel([
        Animated.timing(tx, { toValue: -PANEL_W, ...motionSpec('drawerExit', false) }),
        Animated.timing(fade, { toValue: 0, ...motionSpec('drawerExit', false) }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible]);

  const panelBody = (
    <>
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {hosts.map((host) => {
          const health = healthByHost[host.id] ?? 'unknown';
          const unavailable = health === 'unreachable' || health === 'unauthorized';
          const hostSessions = unavailable
            ? []
            : sessions.filter((session) => session.hostId === host.id);
          return (
            <View
              key={host.id}
              style={[
                styles.hostSection,
                { borderLeftColor: host.color },
                unavailable && styles.hostSectionUnavailable,
              ]}
              accessibilityLabel={`${host.name} host section`}
            >
              <View style={styles.hostHeader}>
                <Text style={styles.hostName}>{host.name}</Text>
                {health === 'unknown' && <Text style={styles.hostStatus}>connecting…</Text>}
                {health === 'reachable' && (
                  <Text style={[styles.hostStatus, styles.hostReachable]}>online</Text>
                )}
                {health === 'unreachable' && (
                  <TouchableOpacity
                    onPress={() => onRetryHost(host.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Retry ${host.name}`}
                  >
                    <Text style={styles.hostAction}>Retry</Text>
                  </TouchableOpacity>
                )}
                {health === 'unauthorized' && (
                  <TouchableOpacity
                    onPress={() => onReenterPassword(host.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Re-enter password for ${host.name}`}
                  >
                    <Text style={styles.hostAction}>Re-enter password</Text>
                  </TouchableOpacity>
                )}
                {onHostSettings && (
                  <TouchableOpacity
                    onPress={() => onHostSettings(host.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Server settings for ${host.name}`}
                  >
                    <Feather name="settings" size={14} color={theme.colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
              {hostSessions.map((s) => {
                const active =
                  activePreviewId === null && s.hostId === activeHostId && s.id === activeId;
                const live = active || isRecentlyActive(s.last_output_at);
                const dotKey = activityDotKey(s.status, s.activity, live);
                const dotColor = {
                  stopped: theme.colors.textFaint,
                  waiting: theme.colors.warning,
                  working: theme.colors.success,
                  idle: theme.colors.border,
                }[dotKey];
                return (
                  <View
                    key={`${s.hostId}:${s.id}`}
                    style={[styles.row, active && styles.rowActive]}
                  >
                    <TouchableOpacity
                      style={styles.rowMain}
                      activeOpacity={0.6}
                      onPress={() => onSelect(s.hostId, s.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={terminalAccessibilityLabel(
                        `${sessionLabel(s)} on ${host.name}`,
                        s.status,
                        s.activity,
                        live,
                      )}
                    >
                      <View style={[styles.dot, { backgroundColor: dotColor }]} />
                      <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
                        {sessionLabel(s)}
                      </Text>
                      {s.status === 'stopped' && <Text style={styles.stopped}>stopped</Text>}
                      {dotKey === 'waiting' && (
                        <Text style={[styles.stopped, { color: theme.colors.warning }]}>
                          input?
                        </Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.kill}
                      hitSlop={HIT_SLOP}
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
            </View>
          );
        })}
        {previews.map((preview) => {
          const active = preview.id === activePreviewId;
          return (
            <View key={`preview-${preview.id}`} style={[styles.row, active && styles.rowActive]}>
              <TouchableOpacity
                style={styles.rowMain}
                activeOpacity={0.6}
                onPress={() => onSelectPreview(preview.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Preview ${preview.title}`}
              >
                <Feather
                  name="layout"
                  size={14}
                  color={theme.colors.accent}
                  style={styles.previewIcon}
                />
                <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
                  {preview.title}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.kill}
                hitSlop={HIT_SLOP}
                activeOpacity={0.6}
                onPress={() => onClosePreview(preview.id)}
                accessibilityRole="button"
                accessibilityLabel={`Close preview ${preview.title}`}
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
        <SafeAreaView edges={['top']} style={styles.panelContent}>
          {panelBody}
        </SafeAreaView>
      </Animated.View>
    </View>
  );
}

const createStyles = (c: AppColors) =>
  StyleSheet.create({
    overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
    scrim: { flex: 1, backgroundColor: c.overlay },
    panel: {
      width: PANEL_W,
      backgroundColor: c.surface,
      borderRightWidth: 1,
      borderRightColor: c.border,
      paddingHorizontal: 12,
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
    },
    panelContent: { flex: 1, paddingTop: 56 },
    // Docked (desktop): inline column, no absolute positioning, tighter top pad
    // (no mobile status bar to clear).
    panelDocked: { position: 'relative', paddingTop: 8, alignSelf: 'stretch' },
    list: { flex: 1 },
    hostSection: { marginBottom: 8, borderLeftWidth: 1, paddingLeft: 6 },
    hostSectionUnavailable: { opacity: 0.52 },
    hostHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 34,
      paddingHorizontal: 4,
      gap: 7,
    },
    hostName: { color: c.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
    hostStatus: { marginLeft: 'auto', color: c.textFaint, fontSize: 11 },
    hostReachable: { color: c.success },
    hostAction: { marginLeft: 'auto', color: c.accent, fontSize: 11, fontWeight: '600' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: SURFACE_RADIUS.control,
      marginBottom: 4,
      minHeight: MIN_TOUCH_TARGET,
      backgroundColor: c.surfaceRaised,
    },
    rowActive: { backgroundColor: c.selected },
    rowMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: 10,
      paddingVertical: 11,
    },
    dot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
    previewIcon: { marginRight: 10 },
    name: { color: c.text, fontFamily: 'Courier', fontSize: 13 },
    nameActive: { color: c.accent, fontWeight: '700' },
    stopped: { color: c.textFaint, fontSize: 10, marginLeft: 8 },
    kill: {
      minWidth: MIN_TOUCH_TARGET,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: 12,
      paddingVertical: 11,
      alignItems: 'center',
      justifyContent: 'center',
    },
    newBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      marginVertical: 12,
      paddingVertical: 13,
      borderRadius: SURFACE_RADIUS.control,
      minHeight: MIN_TOUCH_TARGET,
      backgroundColor: c.accent,
    },
    newBtnText: { color: c.accentText, fontWeight: '600', fontSize: 13 },
  });
