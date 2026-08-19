import Feather from '@expo/vector-icons/Feather';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import type { ComponentProps, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Keyboard, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { ArrowCluster } from './Dpad';
import { HoldPopupKey } from './HoldPopupKey';
import { MIN_TOUCH_TARGET } from './interaction';
import { UTILITY_BAR_PAGES, type UtilityBarKey } from './utilityBarModel';

export { UTILITY_BAR_PAGES } from './utilityBarModel';

const BAR_GUTTER = 8;
const BAR_PAD_V = 2;

type BarStyles = ReturnType<typeof createStyles>;

type UtilityBarProps = {
  ctrlArmed: boolean;
  setCtrlArmed: (updater: (prev: boolean) => boolean) => void;
  sendKey: (bytes: string) => void;
  cursorSeq: (final: string) => string;
  page: number;
  setPage: (page: number) => void;
  onPaste: () => void;
  onImagePick: () => void;
  onHideKeyboard: () => void;
};

function useKeyboardVisible() {
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return keyboardVisible;
}

function UtilityTextBtn({
  styles,
  label,
  onPress,
  onLongPress,
}: {
  styles: BarStyles;
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <TouchableOpacity
      key={label}
      style={styles.utilityBtn}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.utilityBtnText} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function UtilityIconBtn({
  styles,
  color,
  name,
  label,
  onPress,
}: {
  styles: BarStyles;
  color: string;
  name: ComponentProps<typeof Feather>['name'];
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      key={label}
      style={styles.utilityIconBtn}
      activeOpacity={0.6}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name={name} size={17} color={color} />
    </TouchableOpacity>
  );
}

function UtilityCtrlKey({
  styles,
  ctrlArmed,
  setCtrlArmed,
}: {
  styles: BarStyles;
  ctrlArmed: boolean;
  setCtrlArmed: UtilityBarProps['setCtrlArmed'];
}) {
  return (
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
  );
}

function UtilityHideKey({
  styles,
  color,
  onHideKeyboard,
}: {
  styles: BarStyles;
  color: string;
  onHideKeyboard: () => void;
}) {
  return (
    <TouchableOpacity
      key="hide"
      style={styles.utilityIconBtn}
      activeOpacity={0.6}
      onPress={onHideKeyboard}
      accessibilityRole="button"
      accessibilityLabel="Hide keyboard"
    >
      <MaterialIcons name="keyboard-hide" size={20} color={color} />
    </TouchableOpacity>
  );
}

function UtilityPagerBtn({
  styles,
  color,
  direction,
  clamped,
  lastPage,
  setPage,
}: {
  styles: BarStyles;
  color: string;
  direction: 'prev' | 'next';
  clamped: number;
  lastPage: number;
  setPage: (page: number) => void;
}) {
  return (
    <TouchableOpacity
      key={direction}
      style={styles.pagerBtn}
      activeOpacity={0.6}
      onPress={() => setPage(direction === 'prev' ? clamped - 1 : clamped + 1)}
      accessibilityRole="button"
      accessibilityLabel={direction === 'prev' ? 'Previous utility page' : 'Next utility page'}
      accessibilityHint={`Page ${clamped + 1} of ${lastPage + 1}`}
    >
      <Feather
        name={direction === 'prev' ? 'chevron-left' : 'chevron-right'}
        size={20}
        color={color}
      />
    </TouchableOpacity>
  );
}

const KEY_RENDERERS: Record<
  UtilityBarKey,
  (p: UtilityBarProps, styles: BarStyles, color: string) => ReactNode
> = {
  ctrl: (p, styles) => (
    <UtilityCtrlKey
      key="ctrl"
      styles={styles}
      ctrlArmed={p.ctrlArmed}
      setCtrlArmed={p.setCtrlArmed}
    />
  ),
  tab: (p, styles) => (
    <UtilityTextBtn
      key="tab"
      styles={styles}
      label="Tab"
      onPress={() => p.sendKey('\t')}
      onLongPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        p.sendKey('\x1b[Z');
      }}
    />
  ),
  esc: (p, styles) => (
    <UtilityTextBtn key="esc" styles={styles} label="Esc" onPress={() => p.sendKey('\x1b')} />
  ),
  slash: (p, styles) => (
    <HoldPopupKey
      key="slash"
      label="/"
      altLabel={'\\'}
      onSelect={p.sendKey}
      style={styles.utilityBtn}
      textStyle={styles.utilityBtnText}
    />
  ),
  del: (p, styles) => (
    <UtilityTextBtn key="del" styles={styles} label="Del" onPress={() => p.sendKey('\x1b[3~')} />
  ),
  home: (p, styles) => (
    <UtilityTextBtn
      key="home"
      styles={styles}
      label="Home"
      onPress={() => p.sendKey(p.cursorSeq('H'))}
    />
  ),
  end: (p, styles) => (
    <UtilityTextBtn
      key="end"
      styles={styles}
      label="End"
      onPress={() => p.sendKey(p.cursorSeq('F'))}
    />
  ),
  pgup: (p, styles) => (
    <UtilityTextBtn key="pgup" styles={styles} label="PgUp" onPress={() => p.sendKey('\x1b[5~')} />
  ),
  pgdn: (p, styles) => (
    <UtilityTextBtn key="pgdn" styles={styles} label="PgDn" onPress={() => p.sendKey('\x1b[6~')} />
  ),
  dpad: (p) => (
    <ArrowCluster
      key="dpad"
      onArrow={(dir) => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        p.sendKey(p.cursorSeq(dir));
      }}
    />
  ),
  paste: (p, styles, color) => (
    <UtilityIconBtn
      key="paste"
      styles={styles}
      color={color}
      name="clipboard"
      label="Paste"
      onPress={p.onPaste}
    />
  ),
  image: (p, styles, color) => (
    <UtilityIconBtn
      key="image"
      styles={styles}
      color={color}
      name="image"
      label="Upload image"
      onPress={p.onImagePick}
    />
  ),
  hide: (p, styles, color) => (
    <UtilityHideKey key="hide" styles={styles} color={color} onHideKeyboard={p.onHideKeyboard} />
  ),
};

function renderUtilityKey(k: UtilityBarKey, p: UtilityBarProps, styles: BarStyles, color: string) {
  return KEY_RENDERERS[k](p, styles, color);
}

export function UtilityBar(p: UtilityBarProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme.colors);
  const keyboardVisible = useKeyboardVisible();
  const lastPage = UTILITY_BAR_PAGES.length - 1;
  const clamped = Math.min(Math.max(p.page, 0), lastPage);
  const pager = (direction: 'prev' | 'next') => (
    <UtilityPagerBtn
      styles={styles}
      color={theme.colors.textMuted}
      direction={direction}
      clamped={clamped}
      lastPage={lastPage}
      setPage={p.setPage}
    />
  );
  return (
    <View style={[styles.utilityBar, { paddingBottom: keyboardVisible ? 0 : insets.bottom }]}>
      <ScrollView
        scrollEnabled={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={[
          styles.utilityPage,
          { paddingLeft: BAR_GUTTER + insets.left, paddingRight: BAR_GUTTER + insets.right },
        ]}
        style={styles.utilityPageOuter}
      >
        {clamped > 0 && pager('prev')}
        {UTILITY_BAR_PAGES[clamped].map((k) => renderUtilityKey(k, p, styles, theme.colors.text))}
        {clamped < lastPage && pager('next')}
      </ScrollView>
    </View>
  );
}

const createStyles = (c: AppColors) =>
  StyleSheet.create({
    utilityBar: {
      backgroundColor: c.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingVertical: 0,
    },
    utilityPageOuter: {
      height: MIN_TOUCH_TARGET + BAR_PAD_V * 2,
      flexGrow: 0,
    },
    utilityPage: {
      height: MIN_TOUCH_TARGET + BAR_PAD_V * 2,
      width: '100%',
      paddingVertical: BAR_PAD_V,
      alignItems: 'center',
      justifyContent: 'space-between',
      flexDirection: 'row',
      gap: 4,
      flexGrow: 1,
    },
    utilityBtn: {
      flexBasis: MIN_TOUCH_TARGET,
      flexShrink: 1,
      minWidth: 30,
      height: MIN_TOUCH_TARGET,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 0,
      backgroundColor: c.surfaceRaised,
    },
    utilityBtnText: {
      fontSize: 11,
      fontWeight: '600',
      color: c.text,
      textAlign: 'center',
    },
    utilityBtnActive: {
      backgroundColor: c.accent,
    },
    utilityBtnTextActive: {
      color: c.accentText,
    },
    utilityIconBtn: {
      flexBasis: MIN_TOUCH_TARGET,
      flexShrink: 1,
      minWidth: 30,
      height: MIN_TOUCH_TARGET,
      borderRadius: 0,
      backgroundColor: c.surfaceRaised,
      justifyContent: 'center',
      alignItems: 'center',
    },
    pagerBtn: {
      width: 30,
      height: MIN_TOUCH_TARGET,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 0,
    },
  });
