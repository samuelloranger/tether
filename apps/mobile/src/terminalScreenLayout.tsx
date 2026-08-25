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
import type { TerminalStyles } from './terminalScreenTypes';
import {
  useConnection,
  useFile,
  useGit,
  usePresentation,
  useSession,
  useUi,
} from './tether/context';

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

function openDrawer(
  refreshSessions: () => void,
  refreshPresentations: () => void,
  setDrawerOpen: (open: boolean) => void,
) {
  refreshSessions();
  refreshPresentations();
  setDrawerOpen(true);
}

export function TerminalTitleBar({
  desktopUi,
  terminalVisible,
}: {
  desktopUi: boolean;
  terminalVisible: boolean;
}) {
  const session = useSession();
  const { serverIp, port, setIsConfiguring } = useConnection();
  const { openDiff, changeSummary } = useGit();
  const { activePresentation, refreshPresentations } = usePresentation();
  const { setMenuOpen, setDrawerOpen } = useUi();
  if (!isDesktop) return null;
  const titleBarDrawerMenu = showTitleBarDrawerMenu(desktopUi, session.sidebarPinned);
  const entry = session.entryFor(session.activeId);
  return (
    <TitleBar
      isMac={isMacDesktop}
      title={activePresentation?.title || entry.term.title || session.activeName}
      subtitle={activePresentation?.project || entry.term.cwd || `${serverIp}:${port}`}
      status={session.titleBarStatus}
      onNew={session.newTerminal}
      onChanges={openDiff}
      changeSummary={changeSummary}
      onSettings={() => setIsConfiguring(true)}
      onMenu={() => {
        if (terminalVisible) setMenuOpen(true);
      }}
      onOpenDrawer={
        titleBarDrawerMenu
          ? () => openDrawer(session.refreshSessions, refreshPresentations, setDrawerOpen)
          : undefined
      }
      compact={!desktopUi}
    />
  );
}

function toggleSidebarPin(
  sidebarPinned: boolean,
  persistSidebarPinned: (next: boolean) => void,
  setDrawerOpen: (open: boolean) => void,
) {
  if (sidebarPinned) {
    persistSidebarPinned(false);
    setDrawerOpen(false);
  } else {
    persistSidebarPinned(true);
  }
}

export function TerminalSessionDrawer({ wideUi, docked }: { wideUi: boolean; docked: boolean }) {
  const session = useSession();
  const { profiles, openEditHost, openServerSettings } = useConnection();
  const pres = usePresentation();
  const { drawerOpen, setDrawerOpen } = useUi();
  return (
    <SessionDrawer
      visible={sidebarVisible(docked, drawerOpen)}
      docked={docked}
      showPin={wideUi}
      onTogglePin={() =>
        toggleSidebarPin(session.sidebarPinned, session.persistSidebarPinned, setDrawerOpen)
      }
      hosts={profiles ?? []}
      healthByHost={session.healthByHost}
      sessions={session.drawerSessions}
      activeHostId={session.activeHostId}
      activeId={session.activeId}
      onSelect={(hostId, id) => {
        pres.selectTerminal(hostId, id);
        if (!docked) setDrawerOpen(false);
      }}
      onNew={session.newTerminal}
      onKill={session.killActiveOr}
      onRetryHost={session.refreshHost}
      onReenterPassword={openEditHost}
      previews={pres.presentations}
      activePreviewId={pres.activePresentationId}
      onSelectPreview={(id) => {
        pres.selectPresentation(id);
        if (!docked) setDrawerOpen(false);
      }}
      onClosePreview={pres.closePresentation}
      onClose={() => setDrawerOpen(false)}
      onHostSettings={(hostId) => {
        if (!docked) setDrawerOpen(false);
        openServerSettings(hostId);
      }}
    />
  );
}

function TerminalStage({
  styles,
  desktopUi,
  gitTakeover,
  rendererStatus,
  onStatus,
}: {
  styles: TerminalStyles;
  desktopUi: boolean;
  gitTakeover: boolean;
  rendererStatus: RendererStatus;
  onStatus: (status: RendererStatus) => void;
}) {
  const { activePresentation } = usePresentation();
  if (gitTakeover) return <GitReviewPane />;
  if (activePresentation) return <PresentationPane desktopUi={desktopUi} />;
  return (
    <>
      {!desktopUi && <TerminalBanners />}
      <TerminalCanvas styles={styles} rendererStatus={rendererStatus} onStatus={onStatus} />
    </>
  );
}

export function TerminalMainColumn({
  styles,
  desktopUi,
  docked,
  gitTakeover,
  terminalVisible,
  rendererStatus,
  onStatus,
}: {
  styles: TerminalStyles;
  desktopUi: boolean;
  docked: boolean;
  gitTakeover: boolean;
  terminalVisible: boolean;
  rendererStatus: RendererStatus;
  onStatus: (status: RendererStatus) => void;
}) {
  const { diffOpen } = useGit();
  const { fileLoading } = useFile();
  return (
    <View style={[styles.terminalMain, { position: 'relative' }]}>
      {!desktopUi && (
        <TerminalMobileHeader styles={styles} terminalVisible={terminalVisible} docked={docked} />
      )}
      <FileLoadingCover loading={fileLoading} />
      <TerminalStage
        styles={styles}
        desktopUi={desktopUi}
        gitTakeover={gitTakeover}
        rendererStatus={rendererStatus}
        onStatus={onStatus}
      />
      {diffOpen && desktopUi ? <GitDrawerPane /> : null}
      <FileOverlay styles={styles} />
      {terminalVisible && <TerminalOverflowMenu />}
      <TerminalSessionModals />
      {terminalVisible && (
        <TerminalSelectionAndKeys styles={styles} desktopUi={desktopUi} docked={docked} />
      )}
    </View>
  );
}
