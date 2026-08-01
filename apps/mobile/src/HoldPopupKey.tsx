import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
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
import { usePopupOverlay } from './PopupOverlay';

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
  const id = useId();
  const { setContent } = usePopupOverlay();
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

  // Portal into the app-root overlay instead of a <Modal> — a Modal opens a
  // second native window on iOS, which steals first-responder status from
  // whatever TextInput currently holds the keyboard and dismisses it.
  useEffect(() => {
    if (!popup) {
      setContent(id, null);
      return;
    }
    setContent(
      id,
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
        <Text style={[styles.text, { color: popup.alt ? c.accentText : c.text }]}>{altLabel}</Text>
      </View>,
    );
  }, [popup, id, setContent, altLabel, c.accent, c.accentText, c.border, c.surfaceRaised, c.text]);
  useEffect(() => () => setContent(id, null), [id, setContent]);

  return (
    <View
      {...panResponder.panHandlers}
      style={[style, pressed && { backgroundColor: c.selected }]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={`Hold and slide up for ${altLabel}`}
      // A plain View + PanResponder never fires a touch, so VoiceOver/TalkBack
      // need an explicit activation path for both values, not just the hint.
      accessibilityActions={[
        { name: 'activate', label: `Send ${label}` },
        { name: 'sendAlt', label: `Send ${altLabel}` },
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'sendAlt') onSelect(altLabel);
        else onSelect(label);
      }}
    >
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
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
