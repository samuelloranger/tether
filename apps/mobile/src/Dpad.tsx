import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import {
  D_PAD_BUTTON_SIZE,
  D_PAD_MAX_REPEATS,
  D_PAD_REPEAT_DELAY_MS,
  D_PAD_REPEAT_MS,
  type DPadDirection,
  grantOffset,
  resolveDPadDirection,
  thumbOffset,
} from './dpadModel';

const A11Y_ACTIONS: { name: DPadDirection; label: string }[] = [
  { name: 'A', label: 'Up' },
  { name: 'B', label: 'Down' },
  { name: 'D', label: 'Left' },
  { name: 'C', label: 'Right' },
];

// One compact directional puck: tap a chevron for a single arrow, or drag and
// hold for auto-repeat. It claims its own gestures at touch start so a
// horizontal drag on the puck is a direction, not a page swipe of the
// surrounding paged shortcut bar — page swipes start off the puck.
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
        let sent = 0;
        intervalRef.current = setInterval(() => {
          const active = activeRef.current;
          if (!active || sent >= D_PAD_MAX_REPEATS) {
            stopRepeat();
            return;
          }
          sent++;
          onArrowRef.current(active);
        }, D_PAD_REPEAT_MS);
      }, D_PAD_REPEAT_DELAY_MS);
    },
    [stopRepeat],
  );

  // Offset of the touch inside the puck at grant time; pan deltas are measured
  // from there so a gesture starting on a chevron is not double-counted.
  const originRef = useRef({ x: 0, y: 0 });

  const update = useCallback(
    (dx: number, dy: number) => {
      const x = originRef.current.x + dx;
      const y = originRef.current.y + dy;
      thumb.setValue(thumbOffset(x, y));
      activate(resolveDPadDirection(x, y, activeRef.current));
    },
    [activate, thumb],
  );

  const finish = useCallback(() => {
    stopRepeat();
    activeRef.current = null;
    originRef.current = { x: 0, y: 0 };
    // useNativeDriver stays off on purpose: the same value is driven from JS via
    // thumb.setValue() during the drag, and mixing a JS write with a
    // native-driven node can leave the thumb stuck off center.
    Animated.spring(thumb, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
  }, [stopRepeat, thumb]);

  useEffect(() => stopRepeat, [stopRepeat]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const { locationX, locationY } = event.nativeEvent;
          originRef.current = grantOffset(locationX, locationY);
          update(0, 0);
        },
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
      // Not "adjustable": the puck has two axes, so VoiceOver's single
      // increment/decrement pair can't express it. Four explicit custom actions
      // can — and the drag gesture is unreachable with a screen reader anyway.
      accessibilityRole="button"
      accessibilityLabel="Terminal arrow keys"
      accessibilityHint="Tap an arrow, or drag and hold to repeat. Screen reader: use actions."
      accessibilityActions={A11Y_ACTIONS.map(({ name, label }) => ({ name, label }))}
      onAccessibilityAction={(event) => {
        const action = A11Y_ACTIONS.find((a) => a.name === event.nativeEvent.actionName);
        if (action) onArrowRef.current(action.name);
      }}
    >
      <Animated.View pointerEvents="none" style={{ transform: thumb.getTranslateTransform() }}>
        <View style={styles.axisGlyph}>
          <MaterialIcons
            name="arrow-drop-up"
            size={22}
            color={theme.colors.text}
            style={styles.chevronUp}
          />
          <MaterialIcons
            name="arrow-drop-down"
            size={22}
            color={theme.colors.text}
            style={styles.chevronDown}
          />
          <MaterialIcons
            name="arrow-left"
            size={22}
            color={theme.colors.text}
            style={styles.chevronLeft}
          />
          <MaterialIcons
            name="arrow-right"
            size={22}
            color={theme.colors.text}
            style={styles.chevronRight}
          />
        </View>
      </Animated.View>
    </View>
  );
});

const createStyles = (c: AppColors) =>
  StyleSheet.create({
    arrowCluster: {
      width: D_PAD_BUTTON_SIZE,
      height: D_PAD_BUTTON_SIZE,
      // Square like every other key in the utility bar — a rounded puck in a
      // row of square keys read as a different kind of control.
      borderRadius: 0,
      backgroundColor: c.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    axisGlyph: {
      width: 30,
      height: 30,
      position: 'relative',
    },
    chevronLeft: {
      position: 'absolute',
      left: -6,
      top: 4,
    },
    chevronUp: {
      position: 'absolute',
      top: -6,
      left: 4,
    },
    chevronDown: {
      position: 'absolute',
      bottom: -6,
      left: 4,
    },
    chevronRight: {
      position: 'absolute',
      right: -6,
      top: 4,
    },
  });
