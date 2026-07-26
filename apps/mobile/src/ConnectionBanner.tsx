import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { connectionPresentation, type ConnectionStatus } from './connectionPresentation';
import { HIT_SLOP } from './interaction';
import { motionSpec } from './motion';

// Names the real connection state; renders nothing while connected.
export function ConnectionBanner({
  status,
  hasConnected,
  onEdit,
}: {
  status: ConnectionStatus;
  hasConnected: boolean;
  onEdit: () => void;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  const visible = status !== 'connected';
  const [mounted, setMounted] = useState(visible);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [presentation, setPresentation] = useState(() =>
    connectionPresentation(visible ? status : 'disconnected', hasConnected),
  );
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const translateY = useRef(new Animated.Value(visible ? 0 : -8)).current;

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (visible) setPresentation(connectionPresentation(status, hasConnected));
  }, [hasConnected, status, visible]);

  useEffect(() => {
    opacity.stopAnimation();
    translateY.stopAnimation();
    if (visible) {
      setMounted(true);
      if (reduceMotion) {
        opacity.setValue(1);
        translateY.setValue(0);
        return;
      }
      opacity.setValue(0);
      translateY.setValue(-8);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, ...motionSpec('feedback', false) }),
        Animated.timing(translateY, { toValue: 0, ...motionSpec('feedback', false) }),
      ]).start();
      return;
    }
    if (!mounted) return;
    if (reduceMotion) {
      setMounted(false);
      return;
    }
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, ...motionSpec('drawerExit', false) }),
      Animated.timing(translateY, { toValue: -8, ...motionSpec('drawerExit', false) }),
    ]).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [mounted, opacity, reduceMotion, translateY, visible]);

  if (!mounted) return null;
  const tone = presentation.tone === 'danger' ? theme.colors.danger : theme.colors.warning;
  return (
    <Animated.View style={[styles.reconnectBanner, { opacity, transform: [{ translateY }] }]}>
      <Text style={[styles.reconnectBannerText, { color: tone }]}>{presentation.label}</Text>
      <TouchableOpacity
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel="Edit connection settings"
        hitSlop={HIT_SLOP}
      >
        <Text style={styles.reconnectBannerEdit}>Edit</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function createStyles(c: AppColors) {
  return StyleSheet.create({
    reconnectBanner: {
      backgroundColor: c.surfaceRaised,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingVertical: 6,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    reconnectBannerText: {
      fontSize: 10,
      textAlign: 'center',
    },
    reconnectBannerEdit: {
      fontSize: 11,
      color: c.info,
      fontWeight: '600',
    },
  });
}
