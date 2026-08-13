import { View } from 'react-native';
import { showTitleBarDrawerMenu, sidebarVisible } from './desktopLayout';
import { isDesktop, isMacDesktop } from './platform';
import type { RendererStatus } from './rendererLifecycle';
import { SessionDrawer } from './SessionDrawer';
import { TerminalCanvas } from './TerminalCanvas';
import { TerminalMobileHeader } from './TerminalMobileHeader';
import {
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
import type { TerminalStyles, TetherApp } from './terminalScreenTypes';

export function BellFlash({ visible, color }: { visible: boolean; color: string }) {
  if (!visible) return null;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: color,
        opacity: 0.12,
        zIndex: 999,
      }}
    />
  );
}

function openDrawer(app: TetherApp) {
  app.refreshSessions();
  app.refreshPresentations();
  app.setDrawerOpen(true);
}

export function TerminalTitleBar({
  app,
  desktopUi,
  terminalVisible,
}: {
  app: TetherApp;
  desktopUi: boolean;
  terminalVisible: boolean;
}) {
  if (!isDesktop) return null;
  const titleBarDrawerMenu = showTitleBarDrawerMenu(desktopUi, app.sidebarPinned);
  return (
    <TitleBar
      isMac={isMacDesktop}
      title={
        app.activePresentation?.title || app.entryFor(app.activeId).term.title || app.activeName
      }
      subtitle={
        app.activePresentation?.project ||
        app.entryFor(app.activeId).term.cwd ||
        `${app.serverIp}:${app.port}`
      }
      status={app.titleBarStatus}
      onNew={app.newTerminal}
      onChanges={app.openDiff}
      changeSummary={app.changeSummary}
      onSettings={() => app.setIsConfiguring(true)}
      onMenu={() => {
        if (terminalVisible) app.setMenuOpen(true);
      }}
      onOpenDrawer={titleBarDrawerMenu ? () => openDrawer(app) : undefined}
      compact={!desktopUi}
    />
  );
}

function toggleSidebarPin(app: TetherApp) {
  if (app.sidebarPinned) {
    app.persistSidebarPinned(false);
    app.setDrawerOpen(false);
  } else {
    app.persistSidebarPinned(true);
  }
}

export function TerminalSessionDrawer({
  app,
  desktopUi,
  docked,
}: {
  app: TetherApp;
  desktopUi: boolean;
  docked: boolean;
}) {
  return (
    <SessionDrawer
      visible={sidebarVisible(docked, app.drawerOpen)}
      docked={docked}
      showPin={desktopUi}
      onTogglePin={() => toggleSidebarPin(app)}
      hosts={app.profiles ?? []}
      healthByHost={app.healthByHost}
      sessions={app.drawerSessions}
      activeHostId={app.activeHostId}
      activeId={app.activeId}
      onSelect={(hostId, id) => {
        app.selectTerminal(hostId, id);
        if (!docked) app.setDrawerOpen(false);
      }}
      onNew={app.newTerminal}
      onKill={app.killActiveOr}
      onRetryHost={app.refreshHost}
      onReenterPassword={app.openEditHost}
      previews={app.presentations}
      activePreviewId={app.activePresentationId}
      onSelectPreview={(id) => {
        app.selectPresentation(id);
        if (!docked) app.setDrawerOpen(false);
      }}
      onClosePreview={app.closePresentation}
      onClose={() => app.setDrawerOpen(false)}
      onHostSettings={(hostId) => {
        if (!docked) app.setDrawerOpen(false);
        app.openServerSettings(hostId);
      }}
    />
  );
}

function TerminalStage({
  app,
  styles,
  desktopUi,
  gitTakeover,
  rendererStatus,
  onStatus,
}: {
  app: TetherApp;
  styles: TerminalStyles;
  desktopUi: boolean;
  gitTakeover: boolean;
  rendererStatus: RendererStatus;
  onStatus: (status: RendererStatus) => void;
}) {
  if (gitTakeover) return <GitReviewPane app={app} />;
  if (app.activePresentation) return <PresentationPane app={app} desktopUi={desktopUi} />;
  return (
    <>
      {!desktopUi && <TerminalBanners app={app} />}
      <TerminalCanvas
        app={app}
        styles={styles}
        rendererStatus={rendererStatus}
        onStatus={onStatus}
      />
    </>
  );
}

export function TerminalMainColumn({
  app,
  styles,
  desktopUi,
  gitTakeover,
  terminalVisible,
  rendererStatus,
  onStatus,
}: {
  app: TetherApp;
  styles: TerminalStyles;
  desktopUi: boolean;
  gitTakeover: boolean;
  terminalVisible: boolean;
  rendererStatus: RendererStatus;
  onStatus: (status: RendererStatus) => void;
}) {
  return (
    <View style={[styles.terminalMain, { position: 'relative' }]}>
      {!desktopUi && (
        <TerminalMobileHeader app={app} styles={styles} terminalVisible={terminalVisible} />
      )}
      <FileLoadingCover loading={app.fileLoading} />
      <TerminalStage
        app={app}
        styles={styles}
        desktopUi={desktopUi}
        gitTakeover={gitTakeover}
        rendererStatus={rendererStatus}
        onStatus={onStatus}
      />
      {app.diffOpen && desktopUi ? <GitDrawerPane app={app} /> : null}
      <FileOverlay app={app} styles={styles} />
      {terminalVisible && <TerminalOverflowMenu app={app} />}
      <TerminalSessionModals app={app} />
      {terminalVisible && (
        <TerminalSelectionAndKeys app={app} styles={styles} desktopUi={desktopUi} />
      )}
    </View>
  );
}
