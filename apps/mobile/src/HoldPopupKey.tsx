import * as Haptics from 'expo-haptics';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
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

type PopupState = { x: number; y: number; alt: boolean };

type HoldRefs = {
  originRef: MutableRefObject<{ x: number; y: number }>;
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  altRef: MutableRefObject<boolean>;
  poppedRef: MutableRefObject<boolean>;
};

function clearHoldTimer(timerRef: HoldRefs['timerRef']) {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = null;
}

function createHoldPanResponder(opts: {
  refs: HoldRefs;
  setPressed: Dispatch<SetStateAction<boolean>>;
  setPopup: Dispatch<SetStateAction<PopupState | null>>;
  finish: (commit: boolean) => void;
}) {
  const { refs, setPressed, setPopup, finish } = opts;
  return PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      const { pageX, pageY } = event.nativeEvent;
      refs.originRef.current = { x: pageX, y: pageY };
      setPressed(true);
      refs.altRef.current = false;
      refs.poppedRef.current = false;
      clearHoldTimer(refs.timerRef);
      refs.timerRef.current = setTimeout(() => {
        refs.poppedRef.current = true;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setPopup({ x: refs.originRef.current.x, y: refs.originRef.current.y, alt: false });
      }, HOLD_POPUP_DELAY_MS);
    },
    onPanResponderMove: (event) => {
      if (!refs.poppedRef.current) return;
      const dy = refs.originRef.current.y - event.nativeEvent.pageY;
      const alt = resolveHoldPopupSelection(dy);
      if (alt !== refs.altRef.current) {
        refs.altRef.current = alt;
        Haptics.selectionAsync();
        setPopup((p) => (p ? { ...p, alt } : p));
      }
    },
    onPanResponderRelease: () => finish(true),
    onPanResponderTerminate: () => finish(false),
    onPanResponderTerminationRequest: () => false,
  });
}

function HoldPopupBubble({
  popup,
  altLabel,
  accent,
  accentText,
  surfaceRaised,
  border,
  text,
}: {
  popup: PopupState;
  altLabel: string;
  accent: string;
  accentText: string;
  surfaceRaised: string;
  border: string;
  text: string;
}) {
  return (
    <View
      style={[
        styles.bubble,
        {
          left: popup.x - POPUP_SIZE / 2,
          top: popup.y - POPUP_SIZE - POPUP_GAP,
          backgroundColor: popup.alt ? accent : surfaceRaised,
          borderColor: border,
        },
      ]}
    >
      <Text style={[styles.text, { color: popup.alt ? accentText : text }]}>{altLabel}</Text>
    </View>
  );
}

type HoldPopupKeyProps = {
  label: string;
  altLabel: string;
  onSelect: (value: string) => void;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
};

function useHoldPopupGesture(label: string, altLabel: string, onSelect: (value: string) => void) {
  const [pressed, setPressed] = useState(false);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const altRef = useRef(false);
  const poppedRef = useRef(false);
  const refs = useRef({ originRef, timerRef, altRef, poppedRef }).current;
  const finish = useCallback(
    (commit: boolean) => {
      clearHoldTimer(refs.timerRef);
      setPressed(false);
      const wasAlt = refs.altRef.current;
      const wasPopped = refs.poppedRef.current;
      setPopup(null);
      refs.altRef.current = false;
      refs.poppedRef.current = false;
      if (commit) onSelect(wasPopped && wasAlt ? altLabel : label);
    },
    [altLabel, label, onSelect, refs],
  );
  const panResponder = useMemo(
    () => createHoldPanResponder({ refs, setPressed, setPopup, finish }),
    [finish, refs],
  );
  return { pressed, popup, panResponder };
}

export function HoldPopupKey({
  label,
  altLabel,
  onSelect,
  style,
  textStyle,
  accessibilityLabel,
}: HoldPopupKeyProps) {
  const { theme } = useAppTheme();
  const c = theme.colors;
  const id = useId();
  const { setContent } = usePopupOverlay();
  const { pressed, popup, panResponder } = useHoldPopupGesture(label, altLabel, onSelect);
  useEffect(() => {
    if (!popup) {
      setContent(id, null);
      return;
    }
    setContent(
      id,
      <HoldPopupBubble
        popup={popup}
        altLabel={altLabel}
        accent={c.accent}
        accentText={c.accentText}
        surfaceRaised={c.surfaceRaised}
        border={c.border}
        text={c.text}
      />,
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
