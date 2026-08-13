import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from './AppThemeProvider';
import type { SessionActivity } from './activity';
import { PANEL_W } from './desktopNavigation';
import { motionSpec } from './motion';
import type { Presentation } from './presentations';
import { confirmKill, DrawerPanelBody } from './sessionDrawerRows';
import { createDrawerStyles } from './sessionDrawerStyles';
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
  docked?: boolean;
  showPin?: boolean;
  onTogglePin?: () => void;
}

function useDrawerSlide(visible: boolean) {
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
  return { mounted, tx, fade };
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
  showPin = false,
  onTogglePin,
}: SessionDrawerProps) {
  const { theme } = useAppTheme();
  const styles = createDrawerStyles(theme.colors);
  const { mounted, tx, fade } = useDrawerSlide(visible);
  const body = (
    <DrawerPanelBody
      styles={styles}
      colors={theme.colors}
      hosts={hosts}
      healthByHost={healthByHost}
      sessions={sessions}
      activeHostId={activeHostId}
      activeId={activeId}
      activePreviewId={activePreviewId}
      previews={previews}
      showPin={showPin}
      docked={docked}
      onTogglePin={onTogglePin}
      onSelect={onSelect}
      onKillSession={(id) => confirmKill(id, onKill)}
      onRetryHost={onRetryHost}
      onReenterPassword={onReenterPassword}
      onHostSettings={onHostSettings}
      onSelectPreview={onSelectPreview}
      onClosePreview={onClosePreview}
      onNew={onNew}
    />
  );
  if (docked) return <View style={[styles.panel, styles.panelDocked]}>{body}</View>;
  if (!mounted) return null;
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
        {showPin ? (
          <View style={[styles.panelContent, styles.panelContentDesktop]}>{body}</View>
        ) : (
          <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.panelContent}>
            {body}
          </SafeAreaView>
        )}
      </Animated.View>
    </View>
  );
}
