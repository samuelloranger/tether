import { StyleSheet } from 'react-native';
import type { AppColors } from './appTheme';
import { MIN_TOUCH_TARGET, SURFACE_RADIUS } from './interaction';
import { isDesktop } from './platform';
import { typeScale } from './type';

export const MONO = 'FiraCode_400Regular'; // wide box-drawing/braille/powerline glyph coverage vs. Courier

export function shellStyles(c: AppColors) {
  return {
    appContainer: {
      flex: 1,
      backgroundColor: c.background,
    },
    // Caps the login form width so it doesn't stretch across a wide desktop window.
    rowInputs: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
    },
    halfInput: {
      width: '48%' as const,
    },
    terminalContainer: {
      flex: 1,
      backgroundColor: c.background,
    },
    // The area below the full-width title bar; a row (sidebar + terminal) on desktop.
    terminalBody: {
      flex: 1,
    },
    // Desktop: sidebar + terminal side by side.
    terminalRow: {
      flexDirection: 'row' as const,
    },
    // The terminal column (right of the docked sidebar on desktop; the whole
    // screen on mobile).
    terminalMain: {
      flex: 1,
    },
  };
}

export function headerStyles(c: AppColors) {
  return {
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: c.surface,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    headerInfo: {
      flexDirection: 'column' as const,
      flex: 1,
      marginHorizontal: 8,
    },
    headerTitle: {
      color: c.text,
      ...typeScale.eyebrow,
    },
    headerSubtitle: {
      fontSize: 10,
      color: c.textMuted,
    },
    headerControls: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
    },
    headerBtn: {
      minWidth: MIN_TOUCH_TARGET,
      minHeight: MIN_TOUCH_TARGET,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      borderRadius: SURFACE_RADIUS.control,
      marginLeft: 6,
    },
    headerBtnText: {
      fontSize: 11,
      fontWeight: '600' as const,
      color: c.textMuted,
    },
    headerBtnTextDanger: {
      color: c.danger,
    },
    headerBtnTextActive: {
      color: c.accent,
    },
  };
}

export function badgeStyles(c: AppColors) {
  return {
    statusBadge: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingVertical: 3,
      paddingLeft: 8,
      marginRight: 6,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: c.border,
    },
    badgeConnected: {},
    badgeConnecting: {},
    badgeOffline: {},
    badgeTextConnected: {
      fontSize: 10,
      fontWeight: '600' as const,
      color: c.success,
      fontVariant: ['tabular-nums' as const],
    },
    badgeTextConnecting: {
      fontSize: 10,
      fontWeight: '600' as const,
      color: c.warning,
      fontVariant: ['tabular-nums' as const],
    },
    badgeTextOffline: {
      fontSize: 10,
      fontWeight: '600' as const,
      color: c.danger,
      fontVariant: ['tabular-nums' as const],
    },
    badgeDot: {
      width: 0,
      height: 0,
      marginRight: 0,
    },
    dotConnected: {
      backgroundColor: c.success,
    },
    dotOffline: {
      backgroundColor: c.danger,
    },
    spinIcon: {
      marginRight: 4,
    },
  };
}

export function overlayStyles(c: AppColors) {
  return {
    terminalArea: {
      flex: 1,
      position: 'relative' as const,
    },
    connectionBannerOverlay: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10,
    },
    fileOverlay: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 60,
    },
    // Covers the terminal when the renderer page is gone. Opaque on purpose:
    // what is underneath is the WebView's own blank white, which is exactly the
    // "is it loading forever?" state this replaces.
    rendererStalled: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 20,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 12,
      paddingHorizontal: 32,
      backgroundColor: c.background,
    },
    rendererStalledText: {
      color: c.textMuted,
      textAlign: 'center' as const,
      ...typeScale.body,
    },
    rendererStalledButton: {
      minHeight: 44,
      justifyContent: 'center' as const,
      paddingHorizontal: 20,
      borderRadius: 8,
      backgroundColor: c.accent,
    },
    rendererStalledButtonText: {
      color: c.accentText,
      fontSize: 14,
      fontWeight: '700' as const,
    },
  };
}

export function chromeStyles(c: AppColors) {
  return {
    terminalScroll: {
      flex: 1,
      // Background is set at the call site to theme.terminal.bg so leftover fit
      // pixels and safe-area gutters stay inside the terminal well, not the bezel.
      // Desktop: allow native mouse selection of terminal text (RN-web maps these
      // through; no-ops on native).
      ...(isDesktop ? ({ userSelect: 'text', cursor: 'text' } as object) : null),
    },
    terminalContent: {
      paddingHorizontal: 6,
      paddingVertical: 8,
    },
    terminalEmpty: {
      color: c.textFaint,
      fontFamily: MONO,
      fontSize: 13,
      padding: 16,
    },
    utilityIconText: {
      fontSize: 10,
      fontFamily: MONO,
      color: c.text,
    },
    resizeSpacer: {
      width: 12,
    },
    resizeBtn: {
      paddingVertical: 3,
      paddingHorizontal: 6,
      borderRadius: 4,
      backgroundColor: c.surfaceRaised,
      marginRight: 4,
    },
    resizeBtnActive: {
      backgroundColor: c.selected,
    },
    resizeBtnText: {
      fontSize: 9,
      fontFamily: MONO,
      color: c.textFaint,
    },
    resizeBtnTextActive: {
      color: c.accent,
    },
  };
}

export function inputStyles(c: AppColors) {
  return {
    inputBar: {
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
      padding: 12,
    },
    inputBoxContainer: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      backgroundColor: c.input,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 2,
    },
    hiddenInput: {
      position: 'absolute' as const,
      bottom: 0,
      left: 0,
      width: 1,
      height: 1,
      opacity: 0,
    },
    terminalInput: {
      flex: 1,
      color: c.text,
      fontSize: 16,
      paddingVertical: 8,
      fontFamily: MONO,
    },
    sendBtn: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: c.accent,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
    },
    sendBtnDisabled: {
      opacity: 0.4,
    },
    sendBtnText: {
      color: c.accentText,
      fontSize: 12,
      fontWeight: '600' as const,
    },
  };
}
