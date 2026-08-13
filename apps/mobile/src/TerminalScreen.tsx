import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, useWindowDimensions, View } from 'react-native';
import { useAppTheme } from './AppThemeProvider';
import {
  desktopLayout,
  showTitleBarDrawerMenu,
  sidebarDocked,
  sidebarVisible,
} from './desktopLayout';
import { isDesktop, isMacDesktop } from './platform';
import type { RendererStatus } from './rendererLifecycle';
import { SessionDrawer } from './SessionDrawer';
import { createStyles } from './styles';
import { TerminalCanvas } from './TerminalCanvas';
import { TerminalMobileHeader } from './TerminalMobileHeader';
import {
  TerminalDesktopChrome,
  TerminalOverflowMenu,
  TerminalSelectionAndKeys,
  TerminalSessionModals,
} from './TerminalScreenOverlays';
import {
  FileLoadingCover,
  FileOverlay,
  GitDrawerPane,
  GitReviewPane,
  PresentationPane,
  TerminalBanners,
} from './TerminalScreenPanes';
import TitleBar from './TitleBar';
import { injectTerminalScrollbarStyles } from './terminalScrollbar';
import type { useTetherApp } from './useTetherApp';

export function TerminalScreen({ app }: { app: ReturnType<typeof useTetherApp> }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const { width } = useWindowDimensions();
  const desktopUi = desktopLayout(isDesktop, width) === 'desktop';
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>('loading');
  useEffect(() => {
    if (isDesktop) {
      injectTerminalScrollbarStyles({
        thumb: theme.colors.border,
        thumbHover: theme.colors.textMuted,
        track: theme.terminal.bg,
      });
    }
  }, [theme]);

  const {
    serverIp,
    port,
    setIsConfiguring,
    setMenuOpen,
    setSelectionViewOpen,
    activeId,
    activeHostId,
    drawerOpen,
    setDrawerOpen,
    sidebarPinned,
    persistSidebarPinned,
    drawerSessions,
    profiles,
    healthByHost,
    presentations,
    activePresentation,
    activePresentationId,
    fileView,
    fileLoading,
    diffOpen,
    changeSummary,
    selectTerminal,
    selectPresentation,
    closePresentation,
    refreshPresentations,
    entryFor,
    hydrateRenderer,
    newTerminal,
    killActiveOr,
    refreshSessions,
    refreshHost,
    openEditHost,
    openServerSettings,
    activeName,
    activeBellCount,
    titleBarStatus,
    uploadFile,
    openDiff,
  } = app;

  const docked = sidebarDocked(desktopUi, sidebarPinned);
  const drawerVisible = sidebarVisible(docked, drawerOpen);
  const titleBarDrawerMenu = showTitleBarDrawerMenu(desktopUi, sidebarPinned);
  const toggleSidebarPin = () => {
    if (sidebarPinned) {
      persistSidebarPinned(false);
      setDrawerOpen(false);
    } else {
      persistSidebarPinned(true);
    }
  };

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

  // Desktop GitDrawer keeps the terminal mounted; only mobile GitReview takes over.
  const gitTakeover = diffOpen && !desktopUi;
  const terminalVisible = !fileView && !gitTakeover && !activePresentation;
  useEffect(() => {
    if (terminalVisible) hydrateRenderer();
  }, [terminalVisible]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
      {isDesktop && (
        <TitleBar
          isMac={isMacDesktop}
          title={activePresentation?.title || entryFor(activeId).term.title || activeName}
          subtitle={
            activePresentation?.project || entryFor(activeId).term.cwd || `${serverIp}:${port}`
          }
          status={titleBarStatus}
          onNew={newTerminal}
          onChanges={openDiff}
          changeSummary={changeSummary}
          onSettings={() => setIsConfiguring(true)}
          onMenu={() => {
            if (terminalVisible) setMenuOpen(true);
          }}
          onOpenDrawer={
            titleBarDrawerMenu
              ? () => {
                  refreshSessions();
                  refreshPresentations();
                  setDrawerOpen(true);
                }
              : undefined
          }
          compact={!desktopUi}
        />
      )}
      <View style={[styles.terminalBody, docked && styles.terminalRow]}>
        <SessionDrawer
          visible={drawerVisible}
          docked={docked}
          showPin={desktopUi}
          onTogglePin={toggleSidebarPin}
          hosts={profiles ?? []}
          healthByHost={healthByHost}
          sessions={drawerSessions}
          activeHostId={activeHostId}
          activeId={activeId}
          onSelect={(hostId, id) => {
            selectTerminal(hostId, id);
            if (!docked) setDrawerOpen(false);
          }}
          onNew={newTerminal}
          onKill={killActiveOr}
          onRetryHost={refreshHost}
          onReenterPassword={openEditHost}
          previews={presentations}
          activePreviewId={activePresentationId}
          onSelectPreview={(id) => {
            selectPresentation(id);
            if (!docked) setDrawerOpen(false);
          }}
          onClosePreview={closePresentation}
          onClose={() => setDrawerOpen(false)}
          onHostSettings={(hostId) => {
            if (!docked) setDrawerOpen(false);
            openServerSettings(hostId);
          }}
        />
        <View style={[styles.terminalMain, { position: 'relative' }]}>
          {!desktopUi && (
            <TerminalMobileHeader app={app} styles={styles} terminalVisible={terminalVisible} />
          )}
          <FileLoadingCover loading={fileLoading} />
          {gitTakeover ? (
            <GitReviewPane app={app} />
          ) : activePresentation ? (
            <PresentationPane app={app} desktopUi={desktopUi} />
          ) : (
            <>
              {!desktopUi && <TerminalBanners app={app} />}
              <TerminalCanvas
                app={app}
                styles={styles}
                rendererStatus={rendererStatus}
                onStatus={setRendererStatus}
              />
            </>
          )}
          {diffOpen && desktopUi ? <GitDrawerPane app={app} /> : null}
          <FileOverlay app={app} styles={styles} />
          {terminalVisible && <TerminalOverflowMenu app={app} />}
          <TerminalSessionModals app={app} />
          {terminalVisible && (
            <TerminalSelectionAndKeys app={app} styles={styles} desktopUi={desktopUi} />
          )}
        </View>
      </View>
      <TerminalDesktopChrome app={app} />
    </KeyboardAvoidingView>
  );
}
