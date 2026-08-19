import { StyleSheet } from 'react-native';
import type { AppColors } from './appTheme';
import { PANEL_W } from './desktopNavigation';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';

function chromeStyles(c: AppColors) {
  return StyleSheet.create({
    overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
    scrim: { flex: 1, backgroundColor: c.overlay },
    panel: {
      width: PANEL_W,
      backgroundColor: c.surface,
      borderRightWidth: 1,
      borderRightColor: c.border,
      paddingHorizontal: 12,
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
    },
    panelContent: { flex: 1, paddingTop: 56 },
    panelContentDesktop: { paddingTop: 8 },
    panelDocked: { position: 'relative', paddingTop: 8, alignSelf: 'stretch' },
    pinRow: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      paddingHorizontal: 4,
      paddingBottom: 4,
    },
    pinBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: 8,
    },
    pinLabel: { color: c.textMuted, fontSize: 12, fontWeight: '600' },
    list: { flex: 1 },
  });
}

function itemStyles(c: AppColors) {
  return StyleSheet.create({
    hostSection: { marginBottom: 8, borderLeftWidth: 2, paddingLeft: 8 },
    hostSectionUnavailable: { opacity: 0.52 },
    hostHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 34,
      paddingHorizontal: 4,
      gap: 7,
    },
    hostName: { color: c.text, fontSize: 11, fontWeight: '600' },
    hostStatus: {
      marginLeft: 'auto',
      color: c.textFaint,
      fontSize: 11,
      fontVariant: ['tabular-nums'],
    },
    hostReachable: { color: c.success },
    hostAction: { marginLeft: 'auto', color: c.accent, fontSize: 11, fontWeight: '600' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 0,
      marginBottom: 0,
      minHeight: MIN_TOUCH_TARGET,
      backgroundColor: 'transparent',
      borderLeftWidth: 2,
      borderLeftColor: 'transparent',
      marginLeft: -10,
      paddingLeft: 8,
    },
    rowActive: { backgroundColor: c.selected },
    rowMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: 10,
      paddingVertical: 11,
    },
    previewIcon: { marginRight: 10 },
    name: { color: c.text, fontSize: 13 },
    nameActive: { color: c.text, fontWeight: '700' },
    stopped: { color: c.textFaint, fontSize: 10, marginLeft: 8, fontVariant: ['tabular-nums'] },
    kill: {
      minWidth: MIN_TOUCH_TARGET,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: 12,
      paddingVertical: 11,
      alignItems: 'center',
      justifyContent: 'center',
    },
    newBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      marginVertical: 12,
      paddingVertical: 13,
      borderRadius: SURFACE_RADIUS.hero,
      minHeight: MIN_TOUCH_TARGET,
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: c.border,
    },
    newBtnText: { color: c.text, fontWeight: '600', fontSize: 13 },
  });
}

export function createDrawerStyles(c: AppColors) {
  return { ...chromeStyles(c), ...itemStyles(c) };
}

export type DrawerStyles = ReturnType<typeof createDrawerStyles>;
