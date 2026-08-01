import * as Haptics from 'expo-haptics';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Modal,
  PanResponder,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import { HOLD_POPUP_DELAY_MS, resolveHoldPopupSelection } from './holdPopupKeyModel';

const POPUP_SIZE = 44;
const POPUP_GAP = 8;

// A key that behaves like an iOS keyboard accent key: tap sends `label`, but
// hold past HOLD_POPUP_DELAY_MS pops `altLabel` up above the finger — slide up
// into it and release to send that instead. Release without crossing the
// threshold (or without ever holding long enough) still sends `label`.
export function HoldPopupKey({
  label,
  altLabel,
  onSelect,
  style,
  textStyle,
  accessibilityLabel,
}: {
  label: string;
  altLabel: string;
  onSelect: (value: string) => void;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
}) {
  const { theme } = useAppTheme();
  const c = theme.colors;
  const [pressed, setPressed] = useState(false);
  const [popup, setPopup] = useState<{ x: number; y: number; alt: boolean } | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const altRef = useRef(false);
  const poppedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const finish = useCallback(
    (commit: boolean) => {
      clearTimer();
      setPressed(false);
      const wasAlt = altRef.current;
      const wasPopped = poppedRef.current;
      setPopup(null);
      altRef.current = false;
      poppedRef.current = false;
      if (commit) onSelect(wasPopped && wasAlt ? altLabel : label);
    },
    [altLabel, clearTimer, label, onSelect],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const { pageX, pageY } = event.nativeEvent;
          originRef.current = { x: pageX, y: pageY };
          setPressed(true);
          altRef.current = false;
          poppedRef.current = false;
          clearTimer();
          timerRef.current = setTimeout(() => {
            poppedRef.current = true;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setPopup({ x: originRef.current.x, y: originRef.current.y, alt: false });
          }, HOLD_POPUP_DELAY_MS);
        },
        onPanResponderMove: (event) => {
          if (!poppedRef.current) return;
          const dy = originRef.current.y - event.nativeEvent.pageY;
          const alt = resolveHoldPopupSelection(dy);
          if (alt !== altRef.current) {
            altRef.current = alt;
            Haptics.selectionAsync();
            setPopup((p) => (p ? { ...p, alt } : p));
          }
        },
        onPanResponderRelease: () => finish(true),
        onPanResponderTerminate: () => finish(false),
        onPanResponderTerminationRequest: () => false,
      }),
    [clearTimer, finish],
  );

  return (
    <View
      {...panResponder.panHandlers}
      style={[style, pressed && { backgroundColor: c.selected }]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={`Hold and slide up for ${altLabel}`}
    >
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
      {popup && (
        <Modal transparent visible animationType="none" statusBarTranslucent>
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View
              style={[
                styles.bubble,
                {
                  left: popup.x - POPUP_SIZE / 2,
                  top: popup.y - POPUP_SIZE - POPUP_GAP,
                  backgroundColor: popup.alt ? c.accent : c.surfaceRaised,
                  borderColor: c.border,
                },
              ]}
            >
              <Text style={[styles.text, { color: popup.alt ? c.accentText : c.text }]}>
                {altLabel}
              </Text>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    position: 'absolute',
    width: POPUP_SIZE,
    height: POPUP_SIZE,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 15,
    fontWeight: '700',
  },
});
