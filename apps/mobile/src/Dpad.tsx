import React, { useEffect, useRef } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';

// Press-and-hold repeat for navigation keys: fire once on press, then repeat
// after 350ms at 60ms — mirrors hardware key-repeat.
function RepeatBtn({
  onFire,
  style,
  label,
  children,
}: {
  onFire: () => void;
  style: object;
  label: string;
  children: React.ReactNode;
}) {
  const delay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iv = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (delay.current) clearTimeout(delay.current);
    if (iv.current) clearInterval(iv.current);
    delay.current = null;
    iv.current = null;
  };
  useEffect(() => stop, []);
  return (
    <TouchableOpacity
      style={style}
      activeOpacity={0.6}
      onPressIn={() => {
        onFire();
        delay.current = setTimeout(() => {
          iv.current = setInterval(onFire, 60);
        }, 350);
      }}
      onPressOut={stop}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {children}
    </TouchableOpacity>
  );
}

// Directional pad, styled after the arrow clusters in Blink/Termius: one
// capsule with three segments (left | up-over-down | right) instead of four
// separate buttons — reads as a single control and halves the width four
// loose buttons would cost in an already-tight toolbar.
export const ArrowCluster = React.memo(function ArrowCluster({
  onArrow,
}: {
  onArrow: (dir: 'A' | 'B' | 'C' | 'D') => void;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  return (
    <View style={styles.arrowCluster}>
      <RepeatBtn style={styles.arrowSeg} label="Arrow left" onFire={() => onArrow('D')}>
        <Feather name="chevron-left" size={18} color={theme.colors.text} />
      </RepeatBtn>
      <View style={styles.arrowVDivider} />
      <View style={styles.arrowMid}>
        <RepeatBtn style={styles.arrowMidHalf} label="Arrow up" onFire={() => onArrow('A')}>
          <Feather name="chevron-up" size={15} color={theme.colors.text} />
        </RepeatBtn>
        <View style={styles.arrowHDivider} />
        <RepeatBtn style={styles.arrowMidHalf} label="Arrow down" onFire={() => onArrow('B')}>
          <Feather name="chevron-down" size={15} color={theme.colors.text} />
        </RepeatBtn>
      </View>
      <View style={styles.arrowVDivider} />
      <RepeatBtn style={styles.arrowSeg} label="Arrow right" onFire={() => onArrow('C')}>
        <Feather name="chevron-right" size={18} color={theme.colors.text} />
      </RepeatBtn>
    </View>
  );
});

const createStyles = (c: AppColors) => StyleSheet.create({
  arrowCluster: {
    flexDirection: 'row',
    height: 40,
    borderRadius: 8,
    backgroundColor: c.surfaceRaised,
    overflow: 'hidden',
  },
  arrowSeg: {
    width: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowMid: {
    width: 34,
  },
  arrowMidHalf: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowVDivider: {
    width: 1,
    backgroundColor: c.border,
  },
  arrowHDivider: {
    height: 1,
    marginHorizontal: 8,
    backgroundColor: c.border,
  },
});
