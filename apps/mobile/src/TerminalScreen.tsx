import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Pressable,
  PanResponder,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  ActivityIndicator,
  useWindowDimensions,
  Modal,
  Linking,
  AccessibilityInfo,
  type TextStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import Feather from '@expo/vector-icons/Feather';
import { useFonts } from '@expo-google-fonts/fira-code/useFonts';
import { FiraCode_400Regular } from '@expo-google-fonts/fira-code/400Regular';
import { TerminalEmulator, type RenderRow, type CellStyle } from './terminal';
import { splitRunByLinks, urlColumns } from './links';
import { SessionCache, nextTermId, type SessionEntry } from './sessionCache';
import { SessionDrawer, type DrawerSession } from './SessionDrawer';
import { applyFieldChange, SENT } from './input';
import { getPassword, setPassword as persistPassword, authHeaders } from './secureConfig';
import { httpBase, wsUrl, validateAddress } from './address';
import { openTerminalSocket, type TerminalSocket } from './wsTransport';
import { keyToBytes, COPY, PASTE } from './desktopKeys';
import { notify, confirmAction } from './dialog';
import { fetchUpdate, installUpdate, openReleasesPage, type PendingUpdate } from './desktopUpdate';
import TitleBar from './TitleBar';
import { DragDropContentView } from 'expo-drag-drop-content-view';
import { injectDragRegionStyles } from './dragRegion';
import { injectTerminalScrollbarStyles } from './terminalScrollbar';
import { createStyles } from './styles';
import { useAppTheme } from './AppThemeProvider';
import { isDesktop, isMacDesktop } from './platform';
import { TermRow } from './TermRow';
import { ArrowCluster } from './Dpad';
import { ConnectionBanner } from './ConnectionBanner';
import { UtilityBar } from './UtilityBar';
import { OverflowMenu } from './OverflowMenu';
import { RenameModal, SnippetsModal, AppearanceModal } from './SessionModals';
import { SelectionView } from './SelectionView';
import { ContextMenu } from './ContextMenu';
import { UpdateModal } from './UpdateModal';
import { AlertModal } from './AlertModal';
import { ConfigScreen } from './ConfigScreen';
import { mouseSeq } from './mouseSeq';
import { DesktopSessionNavigator } from './DesktopSessionNavigator';
import { PresentationBanner } from './PresentationBanner';
import { PresentationView } from './PresentationView';
import { findSessionPreview, previewUrl } from './presentations';
import { FileViewer } from './FileViewer';


// Constants for async storage keys
const KEY_SERVER_IP = 'tether_server_ip';
const KEY_PORT = 'tether_port';
const KEY_SESSION_ID = 'tether_session_id';
const KEY_FONT = 'tether_font_size';
const KEY_SNIPPETS = 'tether_snippets';


import { useTetherApp } from './useTetherApp';

export function TerminalScreen({ app }: { app: ReturnType<typeof useTetherApp> }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  useEffect(() => {
    if (isDesktop) injectTerminalScrollbarStyles();
  }, []);
  const {
    fontsLoaded, insets, serverIp, setServerIp, port, setPort, password, setPassword, passwordRef, setupMode, setSetupMode, confirmPassword, setConfirmPassword, testStatus, setTestStatus, isConfiguring, setIsConfiguring, ready, setReady, readyRef, lastConnectedRef, connectionStatus, setConnectionStatus, hasConnectedRef, screen, setScreen, inputText, setInputText, prevValueRef, skipNextChangeRef, termHeight, setTermHeight, mouseOn, setMouseOn, ctxMenu, setCtxMenu, updateInfo, setUpdateInfo, pendingUpdate, updateProgress, setUpdateProgress, updating, setUpdating, ctrlArmed, setCtrlArmed, selectionViewOpen, setSelectionViewOpen, menuOpen, setMenuOpen, renameModalOpen, setRenameModalOpen, renameText, setRenameText, appearanceModalOpen, setAppearanceModalOpen, searchQuery, setSearchQuery, searchInputRef, snippets, setSnippets, snippetsModalOpen, setSnippetsModalOpen, snippetDraft, setSnippetDraft, cache, activeId, setActiveId, activeIdRef, drawerOpen, setDrawerOpen, drawerSessions, setDrawerSessions, presentations, activePresentation, activePresentationId, fileView, fileLoading, closeFile, selectTerminal, selectPresentation, closePresentation, refreshPresentations, desktopNavigationMode, selectDesktopNavigationMode, listRef, inputRef, autoScroll, scrolledRef, lastContentHeight, blinkOn, setBlinkOn, reduceMotion, setReduceMotion, renderScheduled, mouseOnRef, wheelAccum, lastDy, CHAR_RATIO, fontSize, setFontSize, lineHeight, paneWidth, gridWidth, numCols, numRows, entryFor, wsSend, panResponder, scheduleRender, resetTerminal, applyWsMessage, connect, disconnect, switchTo, newTerminal, killActiveOr, changeFontSize, persistSnippets, addSnippet, removeSnippet, sendSnippet, refreshSessions, testConnection, saveConfig, sendInput, cursorSeq, getFullText, searchText, openSearch, openSelectionView, copySelection, selectAllTerminal, handlePaste, handleKeyPress, resetField, handleChangeText, handleSend, disposePending, checkForUpdatesManual, startUpdate, downloadUpdate, dismissUpdate, activeName, activeBellCount, upPct, upLabel, openRename, submitRename, hardResetSession, onScroll, renderRow, terminalGrid, titleBarStatus, jumpPrompt, uploadFile, pickAndUploadImage, fontFamily, changeFontFamily,
  } = app;

  // Bell (BEL): brief red flash + haptic tick whenever the active session's
  // bellCount advances, so a background/completed job is noticeable without
  // watching the screen.
  const prevBellCount = useRef(0);
  const [bellFlash, setBellFlash] = useState(false);
  useEffect(() => {
    if (activeBellCount > prevBellCount.current) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setBellFlash(true);
      const t = setTimeout(() => setBellFlash(false), 150);
      prevBellCount.current = activeBellCount;
      return () => clearTimeout(t);
    }
    prevBellCount.current = activeBellCount;
  }, [activeBellCount]);

  // Desktop: drag a file from the OS onto the terminal to upload it into the
  // session's cwd. Plain DOM events (the desktop build is a Tauri webview
  // running react-native-web) — no native Tauri fs plugin/permission needed.
  useEffect(() => {
    if (!isDesktop) return;
    const el = document.getElementById('tether-terminal');
    if (!el) return;
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files || !files.length) return;
      for (const file of Array.from(files)) {
        await uploadFile(file, file.name);
      }
    };
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
    // Re-run when a presentation opens/closes: the #tether-terminal node
    // unmounts/remounts across that transition (see the render branch below),
    // so a stale node reference would silently stop receiving drops.
  }, [uploadFile, activePresentation, fileView]);

  // Desktop: clicking the terminal focuses the hidden IME composition-target
  // input (see the isDesktop TextInput above) — needed so the browser has an
  // actual editable element to attach dead-key/CJK composition sessions to.
  // A plain mousedown listener (not a Pressable) so this stays consistent with
  // the terminal surface remaining a non-focusable View — Pressable would make
  // Enter "activate" it instead of reaching the PTY (see the isDesktop render
  // branch's comment on this exact failure mode).
  useEffect(() => {
    if (!isDesktop) return;
    const el = document.getElementById('tether-terminal');
    if (!el) return;
    const onMouseDown = () => inputRef.current?.focus();
    el.addEventListener('mousedown', onMouseDown);
    return () => el.removeEventListener('mousedown', onMouseDown);
    // Re-run when a presentation opens/closes: the #tether-terminal node
    // unmounts/remounts across that transition (see the render branch below),
    // so an empty deps array would keep this bound to a detached node forever.
  }, [activePresentation, fileView]);

  // OverflowMenu/SelectionView force-unmount below when a takeover is
  // active (bypassing their own onClose), which can happen while either is
  // open — e.g. a new preview auto-selected in the background. Reset their
  // open state here so they don't pop back visible once the preview closes
  // and they remount.
  useEffect(() => {
    if (activePresentation || fileView) {
      setMenuOpen(false);
      setSelectionViewOpen(false);
    }
  }, [activePresentation, fileView, setMenuOpen, setSelectionViewOpen]);

  const sessionPreview = findSessionPreview(presentations, activeId);
  const backTarget = activePresentation?.sessionId ?? activeId;
  const backLabel = drawerSessions.find((s) => s.id === backTarget)?.name || backTarget;
  const terminalVisible = !fileView && !activePresentation;

  return (
        /* Terminal Client Screen */
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.terminalContainer}
        >
          {bellFlash && (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: theme.colors.danger,
                opacity: 0.12,
                zIndex: 999,
              }}
            />
          )}
          {/* Desktop: full-width custom title bar spanning above the sidebar + terminal,
              so macOS traffic lights sit over the bar (not the sidebar) and the whole
              top edge is a drag region. */}
          {isDesktop && (
            <TitleBar
              isMac={isMacDesktop}
              title={activePresentation?.title || entryFor(activeId).term.title || activeName}
              subtitle={activePresentation?.project || entryFor(activeId).term.cwd || `${serverIp}:${port}`}
              status={titleBarStatus}
              onNew={newTerminal}
              onSettings={() => setIsConfiguring(true)}
              onMenu={() => { if (terminalVisible) setMenuOpen(true); }}
            />
          )}
          <View style={[styles.terminalBody, isDesktop && desktopNavigationMode === 'sidebar' && styles.terminalRow]}>
          {/* Desktop session navigator chooses sidebar, hover overlay, or top tabs. */}
          {isDesktop && (
            <DesktopSessionNavigator
              mode={desktopNavigationMode}
              sessions={drawerSessions}
              activeId={activeId}
              onSelect={selectTerminal}
              onNew={newTerminal}
              onKill={killActiveOr}
              previews={presentations}
              activePreviewId={activePresentationId}
              onSelectPreview={selectPresentation}
              onClosePreview={closePresentation}
              onSettings={() => setIsConfiguring(true)}
            />
          )}

          <View style={styles.terminalMain}>
            {/* Mobile header panel */}
            {!isDesktop && (
              <SafeAreaView edges={['top']} style={{ backgroundColor: theme.colors.surface }}>
                <View style={styles.header}>
                  <TouchableOpacity
                    style={styles.headerBtn}
                    activeOpacity={0.6}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    onPress={() => { Keyboard.dismiss(); refreshSessions(); refreshPresentations(); setDrawerOpen(true); }}
                    accessibilityRole="button"
                    accessibilityLabel="Open terminal list"
                  >
                    <Feather name="menu" size={20} color={theme.colors.text} />
                  </TouchableOpacity>

                  <View style={styles.headerInfo}>
                    <Text style={styles.headerTitle}>{activePresentation?.title || activeName}</Text>
                    <Text style={styles.headerSubtitle}>{serverIp}:{port}</Text>
                  </View>

                  <View style={styles.headerControls}>
                    {connectionStatus === 'connected' ? (
                      <View style={[styles.statusBadge, styles.badgeConnected]}>
                        <View style={[styles.badgeDot, styles.dotConnected]} />
                        <Text style={styles.badgeTextConnected}>Connected</Text>
                      </View>
                    ) : connectionStatus === 'auth-failed' ? (
                      <View style={[styles.statusBadge, styles.badgeOffline]}>
                        <View style={[styles.badgeDot, styles.dotOffline]} />
                        <Text style={styles.badgeTextOffline}>Auth</Text>
                      </View>
                    ) : connectionStatus === 'connecting' ? (
                      <View style={[styles.statusBadge, styles.badgeConnecting]}>
                        <ActivityIndicator size={8} color={theme.colors.warning} style={styles.spinIcon} />
                        <Text style={styles.badgeTextConnecting}>Connecting…</Text>
                      </View>
                    ) : (
                      <View style={[styles.statusBadge, styles.badgeOffline]}>
                        <View style={[styles.badgeDot, styles.dotOffline]} />
                        <Text style={styles.badgeTextOffline}>Offline</Text>
                      </View>
                    )}

                    {terminalVisible && (
                      <TouchableOpacity
                        style={styles.headerBtn}
                        activeOpacity={0.6}
                        hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                        onPress={() => setMenuOpen(true)}
                        accessibilityRole="button"
                        accessibilityLabel="Terminal menu"
                      >
                        <Feather name="more-vertical" size={19} color={theme.colors.text} />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              </SafeAreaView>
            )}

          {fileLoading && (
            <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          )}
          {fileView ? <FileViewer file={fileView} onBack={closeFile} /> : activePresentation ? (
            <>
              {!isDesktop && (
                <PresentationBanner
                  label={`Back to ${backLabel}`}
                  icon="terminal"
                  onPress={() => selectTerminal(backTarget)}
                />
              )}
              <PresentationView
                preview={activePresentation}
                url={previewUrl(serverIp, port, activePresentation.url)}
              />
            </>
          ) : <>
          {!isDesktop && sessionPreview && (
            <PresentationBanner
              label={`Preview ready: ${sessionPreview.title}`}
              icon="layout"
              onPress={() => selectPresentation(sessionPreview.id)}
            />
          )}
          {/* Connection banner — names the real state; no safety overclaim. */}
          <ConnectionBanner
            status={connectionStatus}
            hasConnected={hasConnectedRef.current}
            onEdit={() => setIsConfiguring(true)}
          />

          {/* Terminal grid — vertical FlatList inside a horizontal ScrollView so
              wide (e.g. 80-col) output stays legible and scrolls sideways.
              Tapping it focuses the hidden capture field to bring up the keyboard. */}
          <View
            style={styles.terminalScroll}
            onLayout={(e) => setTermHeight(e.nativeEvent.layout.height)}
            {...panResponder.panHandlers}
          >
            {isDesktop ? (
              // Desktop: a plain, non-focusable surface. It must NOT be a Pressable:
              // react-native-web's Pressable is focusable (tabIndex 0) and consumes a
              // focused Enter as an "activate" gesture (PressResponder isValidKeyPress
              // returns true for Enter regardless of role), so Enter never reaches the
              // PTY. Keyboard is captured globally via the window keydown listener;
              // text selection is native (selectable) and actions use the right-click
              // menu — so no press handlers are needed here.
              <View
                nativeID="tether-terminal"
                style={{
                  flex: 1,
                  '--tether-scrollbar-track': theme.terminal.bg,
                  '--tether-scrollbar-thumb': theme.colors.border,
                  '--tether-scrollbar-thumb-hover': theme.colors.selected,
                } as any}
              >
                {terminalGrid}
              </View>
            ) : (
              <Pressable
                nativeID="tether-terminal"
                style={{ flex: 1 }}
                accessibilityRole="button"
                accessibilityLabel="Terminal. Double-tap to type, long-press to select text."
                onPressIn={() => {
                  scrolledRef.current = false;
                }}
                onPress={() => {
                  // Only a genuine tap focuses the input; a scroll-release must not
                  // pop the keyboard.
                  if (!scrolledRef.current) inputRef.current?.focus();
                }}
                onLongPress={openSelectionView}
              >
                {Platform.OS === 'ios' ? (
                  <DragDropContentView
                    style={{ flex: 1 }}
                    onDrop={(event) => {
                      for (const asset of event.assets) {
                        if (!asset.uri) continue;
                        const filename = asset.fileName || `drop-${Date.now()}`;
                        uploadFile({ uri: asset.uri, name: filename, type: asset.type }, filename);
                      }
                    }}
                  >
                    {terminalGrid}
                  </DragDropContentView>
                ) : (
                  terminalGrid
                )}
              </Pressable>
            )}
          </View>
          </>}

          {/* Session Drawer (overlay) — mobile only; desktop uses DesktopSessionNavigator. */}
          {!isDesktop && (
            <SessionDrawer
              visible={drawerOpen}
              sessions={drawerSessions}
              activeId={activeId}
              onSelect={selectTerminal}
              onNew={newTerminal}
              onKill={killActiveOr}
              previews={presentations}
              activePreviewId={activePresentationId}
              onSelectPreview={(id) => { selectPresentation(id); setDrawerOpen(false); }}
              onClosePreview={closePresentation}
              onClose={() => setDrawerOpen(false)}
              onSettings={() => { setDrawerOpen(false); setIsConfiguring(true); }}
            />
          )}

          {/* Overflow menu (header ⋯) */}
          {terminalVisible && <OverflowMenu
            visible={menuOpen}
            onClose={() => setMenuOpen(false)}
            onRename={openRename}
            fontSize={fontSize}
            onFontDelta={changeFontSize}
            onSearch={openSearch}
            onJumpPromptUp={() => jumpPrompt(-1)}
            onJumpPromptDown={() => jumpPrompt(1)}
            onSnippets={() => {
              setMenuOpen(false);
              setSnippetsModalOpen(true);
            }}
            onAppearance={() => {
              setMenuOpen(false);
              setAppearanceModalOpen(true);
            }}
            onCheckUpdates={() => {
              setMenuOpen(false);
              void checkForUpdatesManual();
            }}
            onRestart={() => {
              setMenuOpen(false);
              hardResetSession();
            }}
            desktopNavigationMode={desktopNavigationMode}
            onDesktopNavigationMode={selectDesktopNavigationMode}
          />}

          {/* Rename Modal */}
          <RenameModal
            visible={renameModalOpen}
            onClose={() => setRenameModalOpen(false)}
            value={renameText}
            onChangeText={setRenameText}
            placeholder={activeId}
            onSubmit={submitRename}
          />

          {/* Snippets Modal */}
          <SnippetsModal
            visible={snippetsModalOpen}
            onClose={() => setSnippetsModalOpen(false)}
            snippets={snippets}
            onSend={sendSnippet}
            onRemove={removeSnippet}
            draft={snippetDraft}
            onDraftChange={setSnippetDraft}
            onAdd={addSnippet}
          />

          {/* Appearance Modal (theme + desktop font picker) */}
          <AppearanceModal
            visible={appearanceModalOpen}
            onClose={() => setAppearanceModalOpen(false)}
            fontFamily={fontFamily}
            onFontChange={changeFontFamily}
          />

          {/* Fullscreen selectable-text view (long-press the terminal to open) */}
          {terminalVisible && <SelectionView
            visible={selectionViewOpen}
            onClose={() => {
              setSelectionViewOpen(false);
              setSearchQuery('');
            }}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchInputRef={searchInputRef}
            text={searchText}
            insets={insets}
            fontFamily={fontFamily}
            fontSize={fontSize}
            lineHeight={lineHeight}
          />}

          {/* Mobile Terminal Shortcuts Utility Bar — desktop uses the real keyboard. */}
          {!isDesktop && terminalVisible && (
            <UtilityBar
              ctrlArmed={ctrlArmed}
              setCtrlArmed={setCtrlArmed}
              sendInput={sendInput}
              cursorSeq={cursorSeq}
              onPaste={handlePaste}
              onImagePick={pickAndUploadImage}
            />
          )}

          {/* Hidden keyboard-capture field (mobile): tapping the terminal focuses
              it, so typing goes straight into the terminal (the shell echoes it
              back). Desktop reads the physical keyboard globally instead. */}
          {!isDesktop && terminalVisible && (
            <TextInput
              ref={inputRef}
              style={styles.hiddenInput}
              value={inputText}
              onKeyPress={handleKeyPress}
              onChangeText={handleChangeText}
              onSubmitEditing={handleSend}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              blurOnSubmit={false}
              keyboardAppearance={theme.keyboardAppearance}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              accessibilityLabel="Terminal input (hidden)"
            />
          )}

          {/* Hidden IME/dead-key composition target (desktop): the terminal
              surface is a plain non-focusable View, so it can't receive an OS
              composition session on its own — this gives the browser an actual
              editable element to compose into (é/ñ/ö dead-keys, CJK IME candidate
              windows). Regular typing is unaffected: it's still forwarded by the
              global keydown listener in useTetherApp.tsx, which preventDefault()s
              every key it handles, so this field never receives non-composing
              keystrokes. Rendered inside #tether-terminal so the keydown/
              composition focus-guard (desktopFocusGuard.ts) already treats it as
              part of the terminal. Focused on click via the effect below. */}
          {isDesktop && terminalVisible && (
            <TextInput
              ref={inputRef}
              style={styles.hiddenInput}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              accessibilityLabel="Terminal IME composition target (hidden)"
            />
          )}
          </View>
          </View>

          {/* Desktop right-click menu */}
          {isDesktop && (
            <ContextMenu
              menu={ctxMenu}
              onClose={() => setCtxMenu(null)}
              onCopy={() => void copySelection()}
              onPaste={() => void handlePaste()}
              onSelectAll={selectAllTerminal}
            />
          )}

          {/* Desktop self-update modal */}
          {isDesktop && (
            <UpdateModal
              info={updateInfo}
              updating={updating}
              pct={upPct}
              label={upLabel}
              onDismiss={dismissUpdate}
              onUpdate={startUpdate}
              onDownload={downloadUpdate}
            />
          )}
          {isDesktop && <AlertModal />}
        </KeyboardAvoidingView>
  );
}
