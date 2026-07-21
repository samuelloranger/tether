import { StyleSheet } from 'react-native';
import type { AppColors } from './appTheme';
import { isDesktop } from './platform';

export const MONO = 'FiraCode_400Regular'; // wide box-drawing/braille/powerline glyph coverage vs. Courier

export function createStyles(c: AppColors) {
  return StyleSheet.create({
    appContainer: {
      flex: 1,
      backgroundColor: c.background,
    },

    /* Config Screen Styles */
    // Caps the login form width so it doesn't stretch across a wide desktop window.
    rowInputs: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    halfInput: {
      width: '48%',
    },

    /* Terminal Screen Styles */
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
      flexDirection: 'row',
    },
    // The terminal column (right of the docked sidebar on desktop; the whole
    // screen on mobile).
    terminalMain: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: c.surface,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    headerInfo: {
      flexDirection: 'column',
      flex: 1,
      marginHorizontal: 8,
    },
    headerTitle: {
      fontSize: 13,
      fontWeight: 'bold',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: c.text,
    },
    headerSubtitle: {
      fontSize: 10,
      color: c.textMuted,
    },
    headerControls: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    headerBtn: {
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: 4,
      marginLeft: 6,
    },
    headerBtnText: {
      fontSize: 11,
      fontWeight: '600',
      color: c.textMuted,
    },
    headerBtnTextDanger: {
      color: c.danger,
    },
    headerBtnTextActive: {
      color: c.accent,
    },
    statusBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 3,
      paddingHorizontal: 8,
      borderRadius: 9999,
      borderWidth: 1,
      marginRight: 6,
    },
    badgeConnected: {
      backgroundColor: c.surfaceRaised,
      borderColor: c.success,
    },
    badgeConnecting: {
      backgroundColor: c.surfaceRaised,
      borderColor: c.warning,
    },
    badgeOffline: {
      backgroundColor: c.surfaceRaised,
      borderColor: c.danger,
    },
    badgeTextConnected: {
      fontSize: 10,
      fontWeight: '500',
      color: c.success,
    },
    badgeTextConnecting: {
      fontSize: 10,
      fontWeight: '500',
      color: c.warning,
    },
    badgeTextOffline: {
      fontSize: 10,
      fontWeight: '500',
      color: c.danger,
    },
    badgeDot: {
      width: 5,
      height: 5,
      borderRadius: 9999,
      marginRight: 4,
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
    terminalArea: {
      flex: 1,
      position: 'relative',
    },
    connectionBannerOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10,
    },
    terminalScroll: {
      flex: 1,
      backgroundColor: c.background,
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
    inputBar: {
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
      padding: 12,
    },
    inputBoxContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.input,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 2,
    },
    hiddenInput: {
      position: 'absolute',
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
      justifyContent: 'center',
      alignItems: 'center',
    },
    sendBtnDisabled: {
      opacity: 0.4,
    },
    sendBtnText: {
      color: c.accentText,
      fontSize: 12,
      fontWeight: '600',
    },
  });
}
