import { StyleSheet } from 'react-native';
import type { AppColors } from './appTheme';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';

function chromeStyles(c: AppColors) {
  return StyleSheet.create({
    configContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 28,
      backgroundColor: c.background,
    },
    configInner: {
      width: '100%',
      maxWidth: 400,
    },
    configBrandRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    configTitle: {
      fontSize: 34,
      fontWeight: '700',
      letterSpacing: -0.6,
      color: c.text,
    },
    configModeTag: {
      fontSize: 10,
      fontWeight: '600',
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      color: c.textFaint,
    },
    configRule: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
      marginBottom: 10,
    },
    configSubtitle: {
      fontSize: 13,
      color: c.textMuted,
      marginBottom: 8,
      maxWidth: 280,
    },
    manageHosts: { marginBottom: 20, alignSelf: 'flex-start' },
  });
}

function formStyles(c: AppColors) {
  return StyleSheet.create({
    formContainer: {
      backgroundColor: 'transparent',
      paddingTop: 8,
    },
    inputLabel: {
      fontSize: 12,
      fontWeight: '500',
      color: c.textMuted,
      marginBottom: 6,
    },
    configInput: {
      backgroundColor: 'transparent',
      borderWidth: 0,
      borderBottomWidth: 1,
      borderColor: c.border,
      borderRadius: 0,
      color: c.text,
      fontSize: 15,
      paddingVertical: 10,
      paddingHorizontal: 0,
      marginBottom: 18,
    },
    connectBtn: {
      backgroundColor: c.accent,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: 18,
      borderRadius: SURFACE_RADIUS.hero,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 8,
      marginTop: 10,
      alignSelf: 'flex-start',
    },
    connectBtnDisabled: { opacity: 0.65 },
    connectBtnText: {
      color: c.accentText,
      fontSize: 14,
      fontWeight: '700',
    },
    configHint: {
      color: c.textFaint,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 4,
      marginBottom: 12,
    },
    testError: { color: c.danger, fontSize: 13, marginBottom: 10 },
    testOkRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
    testOk: { color: c.success, fontSize: 13 },
  });
}

export function createConfigStyles(c: AppColors) {
  return { ...chromeStyles(c), ...formStyles(c) };
}

export type ConfigStyles = ReturnType<typeof createConfigStyles>;
