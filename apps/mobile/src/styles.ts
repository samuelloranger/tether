import { StyleSheet } from 'react-native';
import { isDesktop } from './platform';

export const MONO = 'FiraCode_400Regular'; // wide box-drawing/braille/powerline glyph coverage vs. Courier

export const styles = StyleSheet.create({
  appContainer: {
    flex: 1,
    backgroundColor: '#070a13',
  },

  /* Config Screen Styles */
  configContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#070a13',
  },
  // Caps the login form width so it doesn't stretch across a wide desktop window.
  configInner: {
    width: '100%',
    maxWidth: 400,
  },
  configLogoContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  configIconBox: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.2)',
    marginBottom: 16,
  },
  configLogoIcon: {
    fontSize: 32,
    fontFamily: MONO,
    fontWeight: 'bold',
    color: '#818cf8',
  },
  configTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 8,
  },
  configSubtitle: {
    fontSize: 12,
    color: '#94a3b8',
    textAlign: 'center',
  },
  formContainer: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: 20,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#94a3b8',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  configInput: {
    backgroundColor: '#030712',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    color: '#e2e8f0',
    fontSize: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 16,
    fontFamily: MONO,
  },
  rowInputs: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  halfInput: {
    width: '48%',
  },
  connectBtn: {
    backgroundColor: '#3730a3',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  connectBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  configHint: { color: '#64748b', fontSize: 12, lineHeight: 17, marginTop: 4, marginBottom: 12 },
  testError: { color: '#f87171', fontSize: 13, marginBottom: 10 },
  testOkRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
  testOk: { color: '#4ade80', fontSize: 13 },

  /* Terminal Screen Styles */
  terminalContainer: {
    flex: 1,
    backgroundColor: '#05070e',
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
    backgroundColor: 'rgba(11, 15, 25, 0.8)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
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
    color: '#ffffff',
  },
  headerSubtitle: {
    fontSize: 10,
    color: '#94a3b8',
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
    color: '#94a3b8',
  },
  headerBtnTextDanger: {
    color: '#f87171',
  },
  headerBtnTextActive: {
    color: '#818cf8',
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
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.2)',
  },
  badgeConnecting: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: 'rgba(245, 158, 11, 0.2)',
  },
  badgeOffline: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: 'rgba(239, 68, 68, 0.2)',
  },
  badgeTextConnected: {
    fontSize: 10,
    fontWeight: '500',
    color: '#34d399',
  },
  badgeTextConnecting: {
    fontSize: 10,
    fontWeight: '500',
    color: '#fbbf24',
  },
  badgeTextOffline: {
    fontSize: 10,
    fontWeight: '500',
    color: '#f87171',
  },
  badgeDot: {
    width: 5,
    height: 5,
    borderRadius: 9999,
    marginRight: 4,
  },
  dotConnected: {
    backgroundColor: '#34d399',
  },
  dotOffline: {
    backgroundColor: '#f87171',
  },
  spinIcon: {
    marginRight: 4,
  },
  terminalScroll: {
    flex: 1,
    backgroundColor: '#05070e',
    // Desktop: allow native mouse selection of terminal text (RN-web maps these
    // through; no-ops on native).
    ...(isDesktop ? ({ userSelect: 'text', cursor: 'text' } as object) : null),
  },
  terminalContent: {
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  terminalEmpty: {
    color: '#64748b',
    fontFamily: MONO,
    fontSize: 13,
    padding: 16,
  },
  selectionViewContainer: {
    flex: 1,
    backgroundColor: '#070a13',
  },
  selectionViewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  selectionViewTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  selectionViewHeaderBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  selectionViewHeaderBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  selectionViewHeaderBtnText: {
    color: '#22d3ee',
    fontWeight: '600',
    fontSize: 14,
  },
  searchInput: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#e2e8f0',
    fontSize: 14,
  },
  selectionViewText: {
    flex: 1,
    padding: 16,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 18,
    color: '#cbd5e1',
  },
  utilityIconText: {
    fontSize: 10,
    fontFamily: MONO,
    color: '#cbd5e1',
  },
  resizeSpacer: {
    width: 12,
  },
  resizeBtn: {
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    marginRight: 4,
  },
  resizeBtnActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
  },
  resizeBtnText: {
    fontSize: 9,
    fontFamily: MONO,
    color: '#64748b',
  },
  resizeBtnTextActive: {
    color: '#818cf8',
  },
  inputBar: {
    backgroundColor: '#0b0f19',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    padding: 12,
  },
  inputBoxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#030712',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
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
  // Desktop right-click menu.
  ctxBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 200 },
  ctxMenu: {
    position: 'absolute',
    minWidth: 168,
    backgroundColor: '#0b0f19',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 8,
    paddingVertical: 4,
  },
  ctxRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 9 },
  ctxText: { color: '#cbd5e1', fontSize: 13 },
  // Desktop self-update modal.
  updateBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  updateCard: {
    width: 360,
    maxWidth: '90%',
    backgroundColor: '#0b0f19',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    padding: 20,
  },
  updateHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  updateTitle: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  updateVersion: { color: '#f8fafc', fontSize: 18, fontWeight: '700' },
  updateSub: { color: '#64748b', fontSize: 12, marginTop: 2 },
  updateNote: { color: '#94a3b8', fontSize: 12, marginTop: 12, lineHeight: 17 },
  updateProgressWrap: { marginTop: 18 },
  updateTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  updateFill: { height: 8, borderRadius: 4, backgroundColor: '#818cf8' },
  updateProgressText: { color: '#94a3b8', fontSize: 12, marginTop: 8, textAlign: 'center' },
  updateBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
  updateBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8 },
  updateBtnPrimary: { backgroundColor: '#3730a3' },
  updateBtnText: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  updateBtnTextPrimary: { color: '#fff' },
  inputPrompt: {
    color: '#34d399',
    fontFamily: MONO,
    fontSize: 16,
    fontWeight: '700',
    marginRight: 8,
  },
  terminalInput: {
    flex: 1,
    color: '#e2e8f0',
    fontSize: 16,
    paddingVertical: 8,
    fontFamily: MONO,
  },
  sendBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#3730a3',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  sendBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
});
