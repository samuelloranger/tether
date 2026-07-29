import Feather from '@expo/vector-icons/Feather';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import type { AppColors } from './appTheme';
import { ArrowCluster } from './Dpad';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import { MONO } from './styles';
import { UTILITY_BAR_PAGES, type UtilityBarKey } from './utilityBarModel';

export { UTILITY_BAR_PAGES } from './utilityBarModel';

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
  const lastPage = UTILITY_BAR_PAGES.length - 1;
  const clamped = Math.min(Math.max(page, 0), lastPage);

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
      <Text style={styles.utilityBtnText} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  const iconBtn = (
    name: React.ComponentProps<typeof Feather>['name'],
    label: string,
    onPress: () => void,
  ) => (
    <TouchableOpacity
      key={label}
      style={styles.utilityIconBtn}
      activeOpacity={0.6}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name={name} size={17} color={theme.colors.text} />
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
    slash: () => textBtn('/', key('/')),
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
    // A keyboard with a down arrow, not a bare chevron — the bare one read as
    // "collapse this bar". Feather has no keyboard glyph, MaterialIcons does.
    hide: () => (
      <TouchableOpacity
        key="hide"
        style={styles.utilityIconBtn}
        activeOpacity={0.6}
        onPress={onHideKeyboard}
        accessibilityRole="button"
        accessibilityLabel="Hide keyboard"
      >
        <MaterialIcons name="keyboard-hide" size={20} color={theme.colors.text} />
      </TouchableOpacity>
    ),
  };

  // The pager lives inline as the edge control of the row it moves away from:
  // next is the last item on every page but the last, prev the first item on
  // every page but the first. No dots row — the arrows are the affordance, and
  // a second row would cost 28pt of terminal for nothing.
  const pagerBtn = (direction: 'prev' | 'next') => (
    <TouchableOpacity
      key={direction}
      style={styles.pagerBtn}
      activeOpacity={0.6}
      onPress={() => setPage(direction === 'prev' ? clamped - 1 : clamped + 1)}
      accessibilityRole="button"
      accessibilityLabel={direction === 'prev' ? 'Previous utility page' : 'Next utility page'}
      accessibilityHint={`Page ${clamped + 1} of ${UTILITY_BAR_PAGES.length}`}
    >
      <Feather
        name={direction === 'prev' ? 'chevron-left' : 'chevron-right'}
        size={20}
        color={theme.colors.textMuted}
      />
    </TouchableOpacity>
  );

  return (
    <View style={styles.utilityBar}>
      {/* Only the current page is mounted and the ScrollView cannot be dragged:
          it is here purely for keyboardShouldPersistTaps, without which a tap on
          a bar key while the soft keyboard is up is eaten by the dismiss
          responder instead of pressing the button. */}
      <ScrollView
        scrollEnabled={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.utilityPage}
        style={styles.utilityPageOuter}
      >
        {clamped > 0 && pagerBtn('prev')}
        {UTILITY_BAR_PAGES[clamped].map((k) => CONTROLS[k]())}
        {clamped < lastPage && pagerBtn('next')}
      </ScrollView>
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
    utilityPageOuter: {
      // Fixed, not minHeight: the bar must never change height between pages,
      // or switching pages shifts the terminal underneath it.
      height: MIN_TOUCH_TARGET,
      flexGrow: 0,
    },
    utilityPage: {
      height: MIN_TOUCH_TARGET,
      paddingHorizontal: 10,
      alignItems: 'center',
      justifyContent: 'space-between',
      flexDirection: 'row',
      gap: 5,
      // The row never wraps, so on a narrow phone the widest labels give up
      // padding first and ellipsize last rather than pushing a control off-screen.
      flexGrow: 1,
    },
    utilityBtn: {
      flexBasis: MIN_TOUCH_TARGET,
      flexShrink: 1,
      minWidth: 36,
      height: MIN_TOUCH_TARGET,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: SURFACE_RADIUS.control,
      backgroundColor: c.surfaceRaised,
    },
    utilityBtnText: {
      fontSize: 11,
      fontWeight: '700',
      fontFamily: MONO,
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
      minWidth: 36,
      height: MIN_TOUCH_TARGET,
      borderRadius: SURFACE_RADIUS.control,
      backgroundColor: c.surfaceRaised,
      justifyContent: 'center',
      alignItems: 'center',
    },
    // Flat, no fill: the pager is chrome, not another key to hit by accident.
    pagerBtn: {
      width: 30,
      height: MIN_TOUCH_TARGET,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: SURFACE_RADIUS.control,
    },
  });
