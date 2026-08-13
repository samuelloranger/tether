import { FiraCode_400Regular } from '@expo-google-fonts/fira-code/400Regular';
import { useFonts } from '@expo-google-fonts/fira-code/useFonts';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type TextInput, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../AppThemeProvider';
import { desktopLayout } from '../desktopLayout';
import { isDesktop } from '../platform';
import { setTheme } from '../terminal';
import type { HostProfile } from './hostStore';
import { bindTetherActions, type TetherActionDeps } from './tetherAppActions';
import { usePresentationPoll, useTranscriptSelection } from './transcriptTools';
import { useAppPreferences } from './useAppPreferences';
import type { useConnectionConfig } from './useConnectionConfig';
import { useDeepLinks } from './useDeepLinks';
import { useDesktopEffects } from './useDesktopEffects';
import { useDesktopUpdater } from './useDesktopUpdater';
import { useFileView } from './useFileView';
import { useGitReview } from './useGitReview';
import { usePresentations } from './usePresentations';
import { usePushRegistration } from './usePushRegistration';
import { useSessionUpload } from './useSessionUpload';
import { useTerminalInput } from './useTerminalInput';
import { useTerminalSessions } from './useTerminalSessions';
import { useTerminalUiState } from './useTerminalUiState';
import { useTerminalViewport } from './useTerminalViewport';

export function useTetherAppChrome() {
  const [fontsReady, fontError] = useFonts({ FiraCode_400Regular, JetBrainsMono_400Regular });
  const fontsLoaded = fontsReady || !!fontError;
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const viewport = useTerminalViewport();
  const ui = useTerminalUiState();
  const updater = useDesktopUpdater();
  useEffect(() => {
    setTheme(theme.terminal);
  }, [theme]);
  return { fontsLoaded, insets, theme, viewport, ui, updater };
}

export function useServerSettingsHost(
  profiles: HostProfile[] | null,
  clientFor: ReturnType<typeof useConnectionConfig>['clientFor'],
  isConfiguring: boolean,
  setIsConfiguring: (value: boolean) => void,
) {
  const [serverSettingsHostId, setServerSettingsHostId] = useState<string | null>(null);
  const serverSettingsHost =
    profiles?.find((profile) => profile.id === serverSettingsHostId) ?? null;
  const serverSettingsClient = serverSettingsHost ? clientFor(serverSettingsHost) : null;
  return {
    serverSettingsHostId,
    serverSettingsHost,
    serverSettingsClient,
    serverSettingsOpen: serverSettingsHostId !== null && !isConfiguring,
    openServerSettings: (hostId: string) => {
      setServerSettingsHostId(hostId);
      setIsConfiguring(true);
    },
    closeServerSettings: () => setServerSettingsHostId(null),
  };
}

export function useTetherAppSessionPresentations(
  connection: ReturnType<typeof useConnectionConfig>,
  chrome: ReturnType<typeof useTetherAppChrome>,
) {
  const closeFileRef = useRef(() => {});
  const sessions = useTerminalSessions({
    client: connection.client,
    profiles: connection.profiles ?? [],
    clientFor: connection.clientFor,
    onReachable: connection.refreshIdentity,
    ready: connection.ready,
    isConfiguring: connection.isConfiguring,
    theme: chrome.theme,
    fontFamily: chrome.viewport.fontFamily,
    fontSize: chrome.viewport.fontSize,
    notificationsEnabledRef: chrome.viewport.notificationsEnabledRef,
    onClearView: () => closeFileRef.current(),
    onClearPresentation: () => setActivePresentationId(null),
    onCloseDrawer: () => chrome.ui.setDrawerOpen(false),
  });
  const presentations = usePresentations({
    client: sessions.activeClient,
    isConfiguring: connection.isConfiguring,
    getActiveSessionId: sessions.getActiveSessionId,
    markAuthFailed: sessions.markAuthFailed,
  });
  const { setActivePresentationId } = presentations;
  return { sessions, presentations, closeFileRef };
}

export function useTetherAppWorkspace(
  connection: ReturnType<typeof useConnectionConfig>,
  sessions: ReturnType<typeof useTerminalSessions>,
  chrome: ReturnType<typeof useTetherAppChrome>,
  closeFileRef: { current: () => void },
) {
  const inputRef = useRef<TextInput | null>(null);
  const input = useTerminalInput({
    send: sessions.wsSend,
    mouseEnabledRef: chrome.viewport.mouseEnabledRef,
    getActiveSessionId: sessions.getActiveSessionId,
    entryFor: sessions.entryFor,
  });
  const prefs = useAppPreferences();
  const pushClients = useMemo(
    () =>
      connection.ready
        ? (connection.profiles ?? []).map((profile) => connection.clientFor(profile))
        : [],
    [connection.ready, connection.profiles, connection.clientFor],
  );
  const { unregisterPushFromHost } = usePushRegistration(pushClients, connection.ready);
  const file = useFileView({
    client: sessions.activeClient,
    getActiveSessionId: sessions.getActiveSessionId,
  });
  closeFileRef.current = file.closeFile;
  const git = useGitReview({
    client: sessions.activeClient,
    activeId: sessions.activeId,
    getActiveSessionId: sessions.getActiveSessionId,
    entryFor: sessions.entryFor,
    getSessionEntry: sessions.getSessionEntry,
    openFile: file.openFile,
  });
  const upload = useSessionUpload({
    client: sessions.activeClient,
    getActiveSessionId: sessions.getActiveSessionId,
    sendPaste: input.sendPaste,
  });
  return { inputRef, input, prefs, unregisterPushFromHost, file, git, upload };
}

type OverlayParts = {
  connection: ReturnType<typeof useConnectionConfig>;
  chrome: ReturnType<typeof useTetherAppChrome>;
  sessions: ReturnType<typeof useTerminalSessions>;
  presentations: ReturnType<typeof usePresentations>;
  workspace: ReturnType<typeof useTetherAppWorkspace>;
  serverSettings: ReturnType<typeof useServerSettingsHost>;
};

function actionDeps(p: OverlayParts): TetherActionDeps {
  const c = p.connection;
  const s = p.sessions;
  const w = p.workspace;
  return {
    snippetDraft: p.chrome.ui.snippetDraft,
    snippets: w.prefs.snippets,
    persistSnippets: w.prefs.persistSnippets,
    setSnippetDraft: p.chrome.ui.setSnippetDraft,
    setSnippetsModalOpen: p.chrome.ui.setSnippetsModalOpen,
    sendPaste: w.input.sendPaste,
    saveConnectionConfig: c.saveConfig,
    resetForEndpointChange: s.resetForEndpointChange,
    resetHostHealth: s.resetHostHealth,
    configuredActiveHostId: c.activeHostId,
    unregisterPushFromHost: w.unregisterPushFromHost,
    removeHostSessions: s.removeHost,
    removeConfiguredHost: c.removeHost,
    profiles: c.profiles,
    updateProfile: c.updateProfile,
    replaceStoredPassword: c.replaceStoredPassword,
    closeDiff: w.git.closeDiff,
    closeFile: w.file.closeFile,
    activateHost: c.activateHost,
    switchTerminal: s.switchTo,
    setActivePresentationId: p.presentations.setActivePresentationId,
    createTerminal: s.newTerminal,
    drawerSessions: s.drawerSessions,
    activeId: s.activeId,
    setRenameText: p.chrome.ui.setRenameText,
    setMenuOpen: p.chrome.ui.setMenuOpen,
    setRenameModalOpen: p.chrome.ui.setRenameModalOpen,
    renameText: p.chrome.ui.renameText,
    activeClient: s.activeClient,
    refreshSessions: s.refreshSessions,
    resetTerminal: s.resetTerminal,
    restartActiveSession: s.restartActiveSession,
    updateIdentity: c.updateIdentity,
    serverSettingsHostId: p.serverSettings.serverSettingsHostId,
  };
}

function transcriptOpts(p: OverlayParts) {
  return {
    searchQuery: p.chrome.ui.searchQuery,
    terminalViewRef: p.sessions.terminalViewRef,
    getTerminalSelection: p.sessions.getTerminalSelection,
    getSessionEntry: p.sessions.getSessionEntry,
    getActiveSessionId: p.sessions.getActiveSessionId,
    sendPaste: p.workspace.input.sendPaste,
    setMenuOpen: p.chrome.ui.setMenuOpen,
    setSearchQuery: p.chrome.ui.setSearchQuery,
    setSelectionViewOpen: p.chrome.ui.setSelectionViewOpen,
  };
}

function desktopEffectsOpts(
  p: OverlayParts,
  transcript: ReturnType<typeof useTranscriptSelection>,
  actions: ReturnType<typeof bindTetherActions>,
  desktopGitDrawer: boolean,
) {
  return {
    isConfiguring: p.connection.isConfiguring,
    presentations: p.presentations.presentations,
    activePresentationId: p.presentations.activePresentationId,
    fileViewOpen: !!p.workspace.file.fileView,
    diffOpen: p.workspace.git.diffOpen && !desktopGitDrawer,
    getSessionEntry: p.sessions.getSessionEntry,
    getActiveSessionId: p.sessions.getActiveSessionId,
    getTerminalSelection: p.sessions.getTerminalSelection,
    inputRef: p.workspace.inputRef,
    sendKey: p.workspace.input.sendKey,
    sendPaste: p.workspace.input.sendPaste,
    handlePaste: transcript.handlePaste,
    selectAllTerminal: transcript.selectAllTerminal,
    newTerminal: actions.newTerminal,
    changeFontSize: p.chrome.viewport.changeFontSize,
    setContextMenu: p.chrome.ui.setCtxMenu,
    setWindowFocused: p.sessions.setWindowFocused,
    isWindowFocused: p.sessions.isWindowFocused,
    refreshSocketActivity: p.sessions.refreshSocketActivity,
    activePromptReturnCount: p.workspace.git.activeEntry.term.promptReturnCount,
  };
}

export function useTetherAppOverlay(p: OverlayParts) {
  const actions = bindTetherActions(actionDeps(p));
  const deepLinks = useDeepLinks({
    profiles: p.connection.profiles ?? null,
    onSession: actions.selectTerminal,
  });
  usePresentationPoll(
    p.connection.isConfiguring,
    p.presentations.refreshPresentations,
    p.connection.serverIp,
    p.connection.port,
  );
  const transcript = useTranscriptSelection(transcriptOpts(p));
  const { width: windowWidth } = useWindowDimensions();
  const desktopGitDrawer = desktopLayout(isDesktop, windowWidth) === 'desktop';
  useDesktopEffects(desktopEffectsOpts(p, transcript, actions, desktopGitDrawer));
  return { actions, deepLinks, transcript };
}
