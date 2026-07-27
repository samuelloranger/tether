import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { ArrowCluster } from './Dpad';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import { MONO } from './styles';
import { UTILITY_BAR_PAGES, type UtilityBarKey } from './utilityBarModel';

export { UTILITY_BAR_PAGES } from './utilityBarModel';

const PAGER_HEIGHT = 28;

// Mobile terminal-shortcuts utility bar — desktop uses the real keyboard.
export function UtilityBar({
  ctrlArmed,
  setCtrlArmed,
  sendKey,
  cursorSeq,
  page,
  setPage,
  onPaste,
  onImagePick,
  onHideKeyboard,
}: {
  ctrlArmed: boolean;
  setCtrlArmed: (updater: (prev: boolean) => boolean) => void;
  // Routes through the armed-Ctrl modifier — never call sendInput directly from
  // here, or Ctrl+<bar key> sends the unmodified key and leaves Ctrl armed for
  // the next typed letter.
  sendKey: (bytes: string) => void;
  cursorSeq: (final: string) => string;
  page: number;
  setPage: (page: number) => void;
  onPaste: () => void;
  onImagePick: () => void;
  onHideKeyboard: () => void;
}) {
  const { theme } = useAppTheme();
  const styles = createStyles(theme.colors);
  const scrollRef = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const lastPage = UTILITY_BAR_PAGES.length - 1;
  const clamped = Math.min(Math.max(page, 0), lastPage);

  // Keep the scroll offset in sync with the page state so the chevrons and a
  // swipe agree on where we are. Waits for the first layout to know the width.
  useEffect(() => {
    if (width > 0) scrollRef.current?.scrollTo({ x: clamped * width, animated: true });
  }, [clamped, width]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width <= 0) return;
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    if (next !== clamped) setPage(Math.min(Math.max(next, 0), lastPage));
  };

  const key = (bytes: string) => () => sendKey(bytes);

  const textBtn = (label: string, onPress: () => void, onLongPress?: () => void) => (
    <TouchableOpacity
      key={label}
      style={styles.utilityBtn}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.utilityBtnText}>{label}</Text>
    </TouchableOpacity>
  );

  const iconBtn = (
    name: React.ComponentProps<typeof Feather>['name'],
    label: string,
    onPress: () => void,
    size = 17,
  ) => (
    <TouchableOpacity
      key={label}
      style={styles.utilityIconBtn}
      activeOpacity={0.6}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name={name} size={size} color={theme.colors.text} />
    </TouchableOpacity>
  );

  // One entry per key in UTILITY_BAR_PAGES — that model drives the rendering,
  // so pages can be reordered or added there without touching this component.
  const CONTROLS: Record<UtilityBarKey, () => React.ReactNode> = {
    ctrl: () => (
      <TouchableOpacity
        key="ctrl"
        style={[styles.utilityBtn, ctrlArmed && styles.utilityBtnActive]}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setCtrlArmed((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityLabel="Control modifier"
        accessibilityState={{ selected: ctrlArmed }}
      >
        <Text style={[styles.utilityBtnText, ctrlArmed && styles.utilityBtnTextActive]}>Ctrl</Text>
      </TouchableOpacity>
    ),
    tab: () =>
      textBtn('Tab', key('\t'), () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        sendKey('\x1b[Z');
      }),
    esc: () => textBtn('Esc', key('\x1b')),
    del: () => textBtn('Del', key('\x1b[3~')),
    home: () => textBtn('Home', () => sendKey(cursorSeq('H'))),
    end: () => textBtn('End', () => sendKey(cursorSeq('F'))),
    pgup: () => textBtn('PgUp', key('\x1b[5~')),
    pgdn: () => textBtn('PgDn', key('\x1b[6~')),
    dpad: () => (
      <ArrowCluster
        key="dpad"
        onArrow={(dir) => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          sendKey(cursorSeq(dir));
        }}
      />
    ),
    paste: () => iconBtn('clipboard', 'Paste', onPaste),
    image: () => iconBtn('image', 'Upload image', onImagePick),
    hide: () => iconBtn('chevron-down', 'Hide keyboard', onHideKeyboard, 18),
  };

  return (
    <View style={styles.utilityBar}>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        // Without this, a tap on a bar button while the soft keyboard is up is
        // eaten by the keyboard-dismiss responder instead of pressing the button.
        keyboardShouldPersistTaps="always"
        onLayout={onLayout}
        onMomentumScrollEnd={onMomentumEnd}
        style={styles.utilityPages}
      >
        {UTILITY_BAR_PAGES.map((keys, index) => (
          <View
            key={keys.join('-')}
            style={[styles.utilityPage, width > 0 && { width }]}
            accessibilityLabel={`Utility page ${index + 1} of ${UTILITY_BAR_PAGES.length}`}
          >
            {keys.map((k) => CONTROLS[k]())}
          </View>
        ))}
      </ScrollView>
      <View style={styles.utilityPager}>
        <TouchableOpacity
          style={[styles.pagerBtn, clamped === 0 && styles.pagerBtnDisabled]}
          onPress={() => setPage(clamped - 1)}
          disabled={clamped === 0}
          accessibilityRole="button"
          accessibilityLabel="Previous utility page"
          accessibilityState={{ disabled: clamped === 0 }}
        >
          <Feather name="chevron-left" size={18} color={theme.colors.text} />
        </TouchableOpacity>
        <View style={styles.pageDots} accessibilityLabel={`Utility page ${clamped + 1}`}>
          {UTILITY_BAR_PAGES.map((keys, index) => (
            <View
              key={keys.join('-')}
              style={[styles.pageDot, index === clamped && styles.pageDotActive]}
            />
          ))}
        </View>
        <TouchableOpacity
          style={[styles.pagerBtn, clamped === lastPage && styles.pagerBtnDisabled]}
          onPress={() => setPage(clamped + 1)}
          disabled={clamped === lastPage}
          accessibilityRole="button"
          accessibilityLabel="Next utility page"
          accessibilityState={{ disabled: clamped === lastPage }}
        >
          <Feather name="chevron-right" size={18} color={theme.colors.text} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const createStyles = (c: AppColors) =>
  StyleSheet.create({
    utilityBar: {
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
      paddingVertical: 8,
    },
    utilityPages: {
      // Fixed, not minHeight: the bar must never change height between pages,
      // or switching pages shifts the terminal underneath it.
      height: MIN_TOUCH_TARGET,
      flexGrow: 0,
    },
    utilityPage: {
      height: MIN_TOUCH_TARGET,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'space-between',
      flexDirection: 'row',
    },
    utilityBtn: {
      minHeight: MIN_TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: 8,
      borderRadius: SURFACE_RADIUS.control,
      backgroundColor: c.surfaceRaised,
    },
    utilityBtnText: {
      fontSize: 13,
      fontWeight: '700',
      fontFamily: MONO,
      color: c.text,
    },
    utilityBtnActive: {
      backgroundColor: c.accent,
    },
    utilityBtnTextActive: {
      color: c.accentText,
    },
    utilityIconBtn: {
      width: MIN_TOUCH_TARGET,
      height: MIN_TOUCH_TARGET,
      borderRadius: SURFACE_RADIUS.control,
      backgroundColor: c.surfaceRaised,
      justifyContent: 'center',
      alignItems: 'center',
    },
    utilityPager: {
      height: PAGER_HEIGHT,
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 10,
    },
    pagerBtn: {
      width: MIN_TOUCH_TARGET,
      height: PAGER_HEIGHT,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: SURFACE_RADIUS.control,
    },
    pagerBtnDisabled: {
      opacity: 0.3,
    },
    pageDots: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    pageDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: c.border,
    },
    pageDotActive: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: c.accent,
    },
  });
