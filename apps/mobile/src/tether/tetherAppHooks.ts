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

function actionDeps(parts: OverlayParts): TetherActionDeps {
  return {
    snippetDraft: parts.chrome.ui.snippetDraft,
    snippets: parts.workspace.prefs.snippets,
    persistSnippets: parts.workspace.prefs.persistSnippets,
    setSnippetDraft: parts.chrome.ui.setSnippetDraft,
    setSnippetsModalOpen: parts.chrome.ui.setSnippetsModalOpen,
    sendPaste: parts.workspace.input.sendPaste,
    saveConnectionConfig: parts.connection.saveConfig,
    resetForEndpointChange: parts.sessions.resetForEndpointChange,
    resetHostHealth: parts.sessions.resetHostHealth,
    configuredActiveHostId: parts.connection.activeHostId,
    unregisterPushFromHost: parts.workspace.unregisterPushFromHost,
    removeHostSessions: parts.sessions.removeHost,
    removeConfiguredHost: parts.connection.removeHost,
    profiles: parts.connection.profiles,
    updateProfile: parts.connection.updateProfile,
    replaceStoredPassword: parts.connection.replaceStoredPassword,
    closeDiff: parts.workspace.git.closeDiff,
    closeFile: parts.workspace.file.closeFile,
    activateHost: parts.connection.activateHost,
    switchTerminal: parts.sessions.switchTo,
    setActivePresentationId: parts.presentations.setActivePresentationId,
    createTerminal: parts.sessions.newTerminal,
    drawerSessions: parts.sessions.drawerSessions,
    activeId: parts.sessions.activeId,
    setRenameText: parts.chrome.ui.setRenameText,
    setMenuOpen: parts.chrome.ui.setMenuOpen,
    setRenameModalOpen: parts.chrome.ui.setRenameModalOpen,
    renameText: parts.chrome.ui.renameText,
    activeClient: parts.sessions.activeClient,
    refreshSessions: parts.sessions.refreshSessions,
    resetTerminal: parts.sessions.resetTerminal,
    restartActiveSession: parts.sessions.restartActiveSession,
    updateIdentity: parts.connection.updateIdentity,
    serverSettingsHostId: parts.serverSettings.serverSettingsHostId,
  };
}

function transcriptOpts(parts: OverlayParts) {
  return {
    searchQuery: parts.chrome.ui.searchQuery,
    terminalViewRef: parts.sessions.terminalViewRef,
    getTerminalSelection: parts.sessions.getTerminalSelection,
    getSessionEntry: parts.sessions.getSessionEntry,
    getActiveSessionId: parts.sessions.getActiveSessionId,
    sendPaste: parts.workspace.input.sendPaste,
    setMenuOpen: parts.chrome.ui.setMenuOpen,
    setSearchQuery: parts.chrome.ui.setSearchQuery,
    setSelectionViewOpen: parts.chrome.ui.setSelectionViewOpen,
  };
}

function desktopEffectsOpts(
  parts: OverlayParts,
  transcript: ReturnType<typeof useTranscriptSelection>,
  actions: ReturnType<typeof bindTetherActions>,
  desktopGitDrawer: boolean,
) {
  return {
    isConfiguring: parts.connection.isConfiguring,
    presentations: parts.presentations.presentations,
    activePresentationId: parts.presentations.activePresentationId,
    fileViewOpen: !!parts.workspace.file.fileView,
    diffOpen: parts.workspace.git.diffOpen && !desktopGitDrawer,
    getSessionEntry: parts.sessions.getSessionEntry,
    getActiveSessionId: parts.sessions.getActiveSessionId,
    getTerminalSelection: parts.sessions.getTerminalSelection,
    inputRef: parts.workspace.inputRef,
    sendKey: parts.workspace.input.sendKey,
    sendPaste: parts.workspace.input.sendPaste,
    handlePaste: transcript.handlePaste,
    selectAllTerminal: transcript.selectAllTerminal,
    newTerminal: actions.newTerminal,
    changeFontSize: parts.chrome.viewport.changeFontSize,
    setContextMenu: parts.chrome.ui.setCtxMenu,
    setWindowFocused: parts.sessions.setWindowFocused,
    isWindowFocused: parts.sessions.isWindowFocused,
    refreshSocketActivity: parts.sessions.refreshSocketActivity,
    activePromptReturnCount: parts.workspace.git.activeEntry.term.promptReturnCount,
  };
}

export function useTetherAppOverlay(parts: OverlayParts) {
  const actions = bindTetherActions(actionDeps(parts));
  const deepLinks = useDeepLinks({
    profiles: parts.connection.profiles ?? null,
    onSession: actions.selectTerminal,
  });
  usePresentationPoll(
    parts.connection.isConfiguring,
    parts.presentations.refreshPresentations,
    parts.connection.serverIp,
    parts.connection.port,
  );
  const transcript = useTranscriptSelection(transcriptOpts(parts));
  const { width: windowWidth } = useWindowDimensions();
  const desktopGitDrawer = desktopLayout(isDesktop, windowWidth) === 'desktop';
  useDesktopEffects(desktopEffectsOpts(parts, transcript, actions, desktopGitDrawer));
  return { actions, deepLinks, transcript };
}
