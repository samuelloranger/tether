import Feather from '@expo/vector-icons/Feather';
import { DragDropContentView } from 'expo-drag-drop-content-view';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AlertModal } from './AlertModal';
import { useAppTheme } from './AppThemeProvider';
import { ChangeBanner } from './ChangeBanner';
import { ConnectionBanner } from './ConnectionBanner';
import { ContextMenu } from './ContextMenu';
import { DesktopSessionNavigator } from './DesktopSessionNavigator';
import { DiffView } from './DiffView';
import { FileViewer } from './FileViewer';
import { OverflowMenu } from './OverflowMenu';
import { PresentationBanner } from './PresentationBanner';
import { PresentationView } from './PresentationView';
import { isDesktop, isMacDesktop } from './platform';
import { findSessionPreview, previewUrl } from './presentations';
import type { RendererStatus } from './rendererLifecycle';
import { SelectionView } from './SelectionView';
import { SessionDrawer } from './SessionDrawer';
import { AppearanceModal, RenameModal, SnippetsModal } from './SessionModals';
import { sessionLabel } from './sessionLabel';
import { createStyles } from './styles';
import { TerminalView } from './TerminalView';
import TitleBar from './TitleBar';
import { injectTerminalScrollbarStyles } from './terminalScrollbar';
import { UpdateModal } from './UpdateModal';
import { UtilityBar } from './UtilityBar';

import type { useTetherApp } from './useTetherApp';

export function TerminalScreen({ app }: { app: ReturnType<typeof useTetherApp> }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>('loading');
  useEffect(() => {
    if (isDesktop) injectTerminalScrollbarStyles();
  }, []);
  const {
    insets,
    serverIp,
    port,
    setIsConfiguring,
    connectionStatus,
    hasConnected,
    ctxMenu,
    setCtxMenu,
    updateInfo,
    updating,
    ctrlArmed,
    setCtrlArmed,
    utilityPage,
    setUtilityPage,
    selectionViewOpen,
    setSelectionViewOpen,
    menuOpen,
    setMenuOpen,
    renameModalOpen,
    setRenameModalOpen,
    renameText,
    setRenameText,
    appearanceModalOpen,
    setAppearanceModalOpen,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    snippets,
    snippetsModalOpen,
    setSnippetsModalOpen,
    snippetDraft,
    setSnippetDraft,
    activeId,
    drawerOpen,
    setDrawerOpen,
    drawerSessions,
    presentations,
    activePresentation,
    activePresentationId,
    fileView,
    fileLoading,
    openFile,
    closeFile,
    diffOpen,
    changeSummary,
    diffSelectedPath,
    diffText,
    diffTruncated,
    diffLoading,
    diffImage,
    openDiff,
    closeDiff,
    selectDiffFile,
    deselectDiffFile,
    diffMode,
    stageFile,
    unstageFile,
    discardFile,
    toggleHunk,
    commitStagedChanges,
    historyEntries,
    historyCommit,
    loadGitLog,
    selectCommit,
    diffSideBySide,
    toggleDiffSideBySide,
    selectTerminal,
    selectPresentation,
    closePresentation,
    refreshPresentations,
    desktopNavigationMode,
    selectDesktopNavigationMode,
    inputRef,
    fontSize,
    lineHeight,
    entryFor,
    terminalViewRef,
    hydrateRenderer,
    onRendererResize,
    onRendererSelection,
    newTerminal,
    killActiveOr,
    changeFontSize,
    mouseEnabled,
    toggleMouseEnabled,
    notificationsEnabled,
    toggleNotificationsEnabled,
    testNotification,
    addSnippet,
    removeSnippet,
    sendSnippet,
    refreshSessions,
    sendTyped,
    sendKey,
    cursorSeq,
    searchText,
    openSelectionView,
    copySelection,
    selectAllTerminal,
    handlePaste,
    checkForUpdatesManual,
    startUpdate,
    downloadUpdate,
    dismissUpdate,
    activeName,
    activeBellCount,
    upPct,
    upLabel,
    openRename,
    submitRename,
    hardResetSession,
    titleBarStatus,
    jumpPrompt,
    uploadFile,
    pickAndUploadImage,
    fontFamily,
    changeFontFamily,
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
      if (!files?.length) return;
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
  }, [uploadFile, activePresentation, fileView, diffOpen]);

  // OverflowMenu/SelectionView force-unmount below when a takeover is
  // active (bypassing their own onClose), which can happen while either is
  // open — e.g. a new preview auto-selected in the background. Reset their
  // open state here so they don't pop back visible once the preview closes
  // and they remount.
  useEffect(() => {
    if (activePresentation || fileView || diffOpen) {
      setMenuOpen(false);
      setSelectionViewOpen(false);
    }
  }, [activePresentation, fileView, diffOpen, setMenuOpen, setSelectionViewOpen]);

  const sessionPreview = findSessionPreview(presentations, activeId);
  const backTarget = activePresentation?.sessionId ?? activeId;
  const backSession = drawerSessions.find((s) => s.id === backTarget);
  const backLabel = backSession ? sessionLabel(backSession) : backTarget;
  const terminalVisible = !fileView && !diffOpen && !activePresentation;
  useEffect(() => {
    if (terminalVisible) hydrateRenderer();
  }, [terminalVisible]);

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
          subtitle={
            activePresentation?.project || entryFor(activeId).term.cwd || `${serverIp}:${port}`
          }
          status={titleBarStatus}
          onNew={newTerminal}
          onSettings={() => setIsConfiguring(true)}
          onMenu={() => {
            if (terminalVisible) setMenuOpen(true);
          }}
        />
      )}
      <View
        style={[
          styles.terminalBody,
          isDesktop && desktopNavigationMode === 'sidebar' && styles.terminalRow,
        ]}
      >
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
                  onPress={() => {
                    Keyboard.dismiss();
                    refreshSessions();
                    refreshPresentations();
                    setDrawerOpen(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Open terminal list"
                >
                  <Feather name="menu" size={20} color={theme.colors.text} />
                </TouchableOpacity>

                <View style={styles.headerInfo}>
                  <Text style={styles.headerTitle}>{activePresentation?.title || activeName}</Text>
                  <Text style={styles.headerSubtitle}>
                    {serverIp}:{port}
                  </Text>
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
                      <ActivityIndicator
                        size={8}
                        color={theme.colors.warning}
                        style={styles.spinIcon}
                      />
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
            <View
              style={{
                position: 'absolute',
                inset: 0,
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1,
              }}
            >
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          )}
          {fileView ? (
            <FileViewer file={fileView} onBack={closeFile} />
          ) : diffOpen ? (
            <DiffView
              summary={changeSummary}
              selectedPath={diffSelectedPath}
              diffMode={diffMode}
              diffText={diffText}
              diffTruncated={diffTruncated}
              diffLoading={diffLoading}
              diffImage={diffImage}
              onSelectFile={selectDiffFile}
              onDeselectFile={deselectDiffFile}
              onBack={closeDiff}
              onStageFile={stageFile}
              onUnstageFile={unstageFile}
              onDiscardFile={discardFile}
              onToggleHunk={toggleHunk}
              onCommit={commitStagedChanges}
              historyEntries={historyEntries}
              historyCommit={historyCommit}
              onLoadHistory={loadGitLog}
              onSelectCommit={selectCommit}
              sideBySide={diffSideBySide}
              onToggleSideBySide={toggleDiffSideBySide}
            />
          ) : activePresentation ? (
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
          ) : (
            <>
              <ChangeBanner summary={changeSummary} onPress={openDiff} />
              {!isDesktop && sessionPreview && (
                <PresentationBanner
                  label={`Preview ready: ${sessionPreview.title}`}
                  icon="layout"
                  onPress={() => selectPresentation(sessionPreview.id)}
                />
              )}
              {/* Terminal grid — the renderer WebView. Tapping it focuses xterm's
              own helper textarea inside the page, which is what raises the soft
              keyboard, so typed characters arrive as renderer `input` events and
              NOT through the hidden RN capture field below. That is why onInput
              is sendTyped: that is where the armed Ctrl modifier is applied,
              and typing is the main thing Ctrl modifies.
              Wrapped in a relative container so the connection banner can overlay
              the top without consuming flex height: a height change would recompute
              rows and fire a spurious PTY resize (visible rewrap) on every
              reconnect. */}
              <View style={styles.terminalArea}>
                <View nativeID="tether-terminal" style={styles.terminalScroll}>
                  {Platform.OS === 'ios' ? (
                    <DragDropContentView
                      style={{ flex: 1 }}
                      onDrop={(event) => {
                        for (const asset of event.assets) {
                          if (!asset.uri) continue;
                          const filename = asset.fileName || `drop-${Date.now()}`;
                          uploadFile(
                            { uri: asset.uri, name: filename, type: asset.type },
                            filename,
                          );
                        }
                      }}
                    >
                      <TerminalView
                        ref={terminalViewRef}
                        onInput={sendTyped}
                        onResize={onRendererResize}
                        onOpenLink={openFile}
                        onSelection={onRendererSelection}
                        onFallback={(reason) => console.warn('Terminal renderer fallback:', reason)}
                        onRecover={hydrateRenderer}
                        onStatus={setRendererStatus}
                      />
                    </DragDropContentView>
                  ) : (
                    <TerminalView
                      ref={terminalViewRef}
                      onInput={sendTyped}
                      onResize={onRendererResize}
                      onOpenLink={openFile}
                      onSelection={onRendererSelection}
                      onFallback={(reason) => console.warn('Terminal renderer fallback:', reason)}
                      onRecover={hydrateRenderer}
                      onStatus={setRendererStatus}
                    />
                  )}
                </View>
                {/* Renderer died and could not be brought back automatically. Say
              so, rather than leaving the WebView's blank white rectangle looking
              like a load that never finishes. */}
                {rendererStatus === 'stalled' && (
                  <View style={styles.rendererStalled}>
                    <Text style={styles.rendererStalledText}>
                      The terminal display stopped responding. Your session is still running on the
                      server — reloading only redraws it.
                    </Text>
                    <TouchableOpacity
                      style={styles.rendererStalledButton}
                      onPress={() => terminalViewRef.current?.retry()}
                      accessibilityRole="button"
                      accessibilityLabel="Reload terminal display"
                    >
                      <Text style={styles.rendererStalledButtonText}>Reload display</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Connection banner — names the real state; no safety overclaim.
              Absolute overlay (box-none) so its mount/unmount never resizes the
              terminal grid. */}
                <View style={styles.connectionBannerOverlay} pointerEvents="box-none">
                  <ConnectionBanner
                    status={connectionStatus}
                    hasConnected={hasConnected}
                    onEdit={() => setIsConfiguring(true)}
                  />
                </View>
              </View>
            </>
          )}

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
              onSelectPreview={(id) => {
                selectPresentation(id);
                setDrawerOpen(false);
              }}
              onClosePreview={closePresentation}
              onClose={() => setDrawerOpen(false)}
              onSettings={() => {
                setDrawerOpen(false);
                setIsConfiguring(true);
              }}
            />
          )}

          {/* Overflow menu (header ⋯) */}
          {terminalVisible && (
            <OverflowMenu
              visible={menuOpen}
              onClose={() => setMenuOpen(false)}
              onRename={openRename}
              onViewChanges={() => {
                setMenuOpen(false);
                void openDiff();
              }}
              fontSize={fontSize}
              onFontDelta={changeFontSize}
              mouseEnabled={mouseEnabled}
              onToggleMouse={toggleMouseEnabled}
              onSelectText={openSelectionView}
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
              notificationsEnabled={notificationsEnabled}
              onToggleNotifications={toggleNotificationsEnabled}
              onTestNotification={() => {
                setMenuOpen(false);
                testNotification();
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
            />
          )}

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
          {terminalVisible && (
            <SelectionView
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
            />
          )}

          {/* Mobile Terminal Shortcuts Utility Bar — desktop uses the real keyboard. */}
          {!isDesktop && terminalVisible && (
            <UtilityBar
              ctrlArmed={ctrlArmed}
              setCtrlArmed={setCtrlArmed}
              sendKey={sendKey}
              cursorSeq={cursorSeq}
              page={utilityPage}
              setPage={setUtilityPage}
              onPaste={handlePaste}
              onImagePick={pickAndUploadImage}
              onHideKeyboard={() => {
                terminalViewRef.current?.blur();
                inputRef.current?.blur();
                Keyboard.dismiss();
              }}
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
