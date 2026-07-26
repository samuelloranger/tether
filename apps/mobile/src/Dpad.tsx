import Feather from '@expo/vector-icons/Feather';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import {
  D_PAD_BUTTON_SIZE,
  resolveDPadDirection,
  thumbOffset,
  type DPadDirection,
} from './dpadModel';

// One compact directional puck: drag from center to select an arrow and hold
// there to repeat. It captures its own gestures so horizontal directions do
// not compete with the surrounding horizontally scrollable shortcut bar.
export const ArrowCluster = React.memo(function ArrowCluster({
  onArrow,
}: {
  onArrow: (dir: DPadDirection) => void;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  const onArrowRef = useRef(onArrow);
  onArrowRef.current = onArrow;
  const thumb = useRef(new Animated.ValueXY()).current;
  const activeRef = useRef<DPadDirection | null>(null);
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRepeat = useCallback(() => {
    if (delayRef.current) clearTimeout(delayRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    delayRef.current = null;
    intervalRef.current = null;
  }, []);

  const activate = useCallback(
    (next: DPadDirection | null) => {
      if (next === activeRef.current) return;
      stopRepeat();
      activeRef.current = next;
      if (!next) return;
      onArrowRef.current(next);
      delayRef.current = setTimeout(() => {
        intervalRef.current = setInterval(() => {
          const active = activeRef.current;
          if (active) onArrowRef.current(active);
        }, 60);
      }, 350);
    },
    [stopRepeat],
  );

  const update = useCallback(
    (dx: number, dy: number) => {
      thumb.setValue(thumbOffset(dx, dy));
      activate(resolveDPadDirection(dx, dy, activeRef.current));
    },
    [activate, thumb],
  );

  const finish = useCallback(() => {
    stopRepeat();
    activeRef.current = null;
    Animated.spring(thumb, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start();
  }, [stopRepeat, thumb]);

  useEffect(() => stopRepeat, [stopRepeat]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => update(0, 0),
        onPanResponderMove: (_event, gesture) => update(gesture.dx, gesture.dy),
        onPanResponderRelease: finish,
        onPanResponderTerminate: finish,
        onPanResponderTerminationRequest: () => false,
      }),
    [finish, update],
  );

  return (
    <View
      {...panResponder.panHandlers}
      style={styles.arrowCluster}
      accessibilityRole="adjustable"
      accessibilityLabel="Terminal arrow control. Drag in a direction and hold to repeat."
    >
      <Animated.View
        pointerEvents="none"
        style={{ transform: thumb.getTranslateTransform() }}
      >
        <Feather name="move" size={18} color={theme.colors.text} />
      </Animated.View>
    </View>
  );
});

const createStyles = (c: AppColors) =>
  StyleSheet.create({
    arrowCluster: {
      width: D_PAD_BUTTON_SIZE,
      height: D_PAD_BUTTON_SIZE,
      borderRadius: 8,
      backgroundColor: c.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
