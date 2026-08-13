import { FiraCode_400Regular } from '@expo-google-fonts/fira-code/400Regular';
import { useFonts } from '@expo-google-fonts/fira-code/useFonts';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type TextInput, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from './AppThemeProvider';
import { desktopLayout } from './desktopLayout';
import { confirmAction, notify } from './dialog';
import { isDesktop } from './platform';
import { sessionLabel } from './sessionLabel';
import { setTheme } from './terminal';
import {
  updateProgressLabel,
  usePresentationPoll,
  useTranscriptSelection,
} from './tether/transcriptTools';
import { useAppPreferences } from './tether/useAppPreferences';
import { useConnectionConfig } from './tether/useConnectionConfig';
import { useDeepLinks } from './tether/useDeepLinks';
import { useDesktopEffects } from './tether/useDesktopEffects';
import { useDesktopUpdater } from './tether/useDesktopUpdater';
import { useFileView } from './tether/useFileView';
import { useGitReview } from './tether/useGitReview';
import { usePresentations } from './tether/usePresentations';
import { usePushRegistration } from './tether/usePushRegistration';
import { useSessionUpload } from './tether/useSessionUpload';
import { useTerminalInput } from './tether/useTerminalInput';
import { useTerminalSessions } from './tether/useTerminalSessions';
import { useTerminalUiState } from './tether/useTerminalUiState';
import { useTerminalViewport } from './tether/useTerminalViewport';

export type { ReviewDiffSlot } from './fetchReviewDiff';
export type { GitLogEntry } from './tether/types';

export function useTetherApp() {
  const [fontsReady, fontError] = useFonts({ FiraCode_400Regular, JetBrainsMono_400Regular });
  const fontsLoaded = fontsReady || !!fontError;
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const connection = useConnectionConfig();
  const {
    serverIp,
    setServerIp,
    port,
    setPort,
    password,
    setPassword,
    passwordRef,
    setupMode,
    setSetupMode,
    confirmPassword,
    setConfirmPassword,
    testStatus,
    setTestStatus,
    isConfiguring,
    setIsConfiguring,
    ready,
    activeHostId: configuredActiveHostId,
    profiles,
    clientFor,
    storeError,
    loadProfiles,
    openAddHost,
    openEditHost,
    activateHost,
    removeHost: removeConfiguredHost,
    updateProfile,
    reorderHosts,
    updateIdentity,
    replaceStoredPassword,
    refreshIdentity,
    client: connectionClient,
    testConnection,
    saveConfig: saveConnectionConfig,
  } = connection;
  const {
    fontSize,
    setFontSize,
    fontFamily,
    changeFontFamily,
    lineHeight,
    changeFontSize,
    mouseEnabled,
    mouseEnabledRef,
    toggleMouseEnabled,
    notificationsEnabled,
    notificationsEnabledRef,
    toggleNotificationsEnabled,
    testNotification,
  } = useTerminalViewport();
  const ui = useTerminalUiState();
  const updater = useDesktopUpdater();
  const [serverSettingsHostId, setServerSettingsHostId] = useState<string | null>(null);
  const serverSettingsHost =
    profiles?.find((profile) => profile.id === serverSettingsHostId) ?? null;
  const serverSettingsClient = serverSettingsHost ? clientFor(serverSettingsHost) : null;
  const closeFileRef = useRef(() => {});

  const sessions = useTerminalSessions({
    client: connectionClient,
    profiles: profiles ?? [],
    clientFor,
    onReachable: refreshIdentity,
    ready,
    isConfiguring,
    theme,
    fontFamily,
    fontSize,
    notificationsEnabledRef,
    onClearView: () => closeFileRef.current(),
    onClearPresentation: () => setActivePresentationId(null),
    onCloseDrawer: () => ui.setDrawerOpen(false),
  });
  const {
    activeId,
    activeHostId,
    activeClient,
    connectionStatus,
    hasConnected,
    drawerSessions,
    healthByHost,
    terminalViewRef,
    entryFor,
    getSessionEntry,
    getActiveSessionId,
    getTerminalSelection,
    wsSend,
    hydrateRenderer,
    onRendererResize,
    onRendererSelection,
    onPageControl,
    onPageReply,
    onPageClipboardWrite,
    resetTerminal,
    switchTo: switchTerminal,
    newTerminal: createTerminal,
    killActiveOr,
    refreshSessions,
    refreshHost,
    resetHostHealth,
    removeHost: removeHostSessions,
    resetForEndpointChange,
    restartActiveSession,
    markAuthFailed,
    refreshSocketActivity,
    setWindowFocused,
    isWindowFocused,
  } = sessions;
  const {
    presentations,
    activePresentationId,
    setActivePresentationId,
    refreshPresentations,
    closePresentation,
  } = usePresentations({
    client: activeClient,
    isConfiguring,
    getActiveSessionId,
    markAuthFailed,
  });

  useEffect(() => {
    setTheme(theme.terminal);
  }, [theme]);

  const inputRef = useRef<TextInput | null>(null);
  const { ctrlArmed, setCtrlArmed, sendTyped, sendKey, sendPaste, sendProgram, cursorSeq } =
    useTerminalInput({ send: wsSend, mouseEnabledRef, getActiveSessionId, entryFor });
  const { snippets, setSnippets, persistSnippets, sidebarPinned, persistSidebarPinned } =
    useAppPreferences();
  const pushClients = useMemo(
    () => (ready ? (profiles ?? []).map((profile) => clientFor(profile)) : []),
    [ready, profiles, clientFor],
  );
  const { unregisterPushFromHost } = usePushRegistration(pushClients, ready);
  const file = useFileView({ client: activeClient, getActiveSessionId });
  closeFileRef.current = file.closeFile;
  const git = useGitReview({
    client: activeClient,
    activeId,
    getActiveSessionId,
    entryFor,
    getSessionEntry,
    openFile: file.openFile,
  });
  const { uploadFile, pickAndUploadImage } = useSessionUpload({
    client: activeClient,
    getActiveSessionId,
    sendPaste,
  });

  const addSnippet = () => {
    const snippet = ui.snippetDraft.trim();
    if (!snippet) return;
    persistSnippets([...snippets, snippet]);
    ui.setSnippetDraft('');
  };
  const removeSnippet = (index: number) => {
    persistSnippets(snippets.filter((_, itemIndex) => itemIndex !== index));
  };
  const sendSnippet = (snippet: string) => {
    ui.setSnippetsModalOpen(false);
    sendPaste(snippet);
  };
  const saveConfig = async () => {
    const { addressChanged, wasReady } = await saveConnectionConfig();
    if (addressChanged && wasReady) resetForEndpointChange();
    if (configuredActiveHostId) resetHostHealth(configuredActiveHostId);
  };
  const removeHost = async (hostId: string) => {
    await unregisterPushFromHost(hostId);
    removeHostSessions(hostId);
    await removeConfiguredHost(hostId);
  };
  const saveHostConnection = async (
    hostId: string,
    changes: { host: string; port: string },
    replacementPassword?: string,
  ) => {
    const current = profiles?.find((profile) => profile.id === hostId);
    if (!current) return;
    const endpointChanged = current.host !== changes.host || current.port !== changes.port;
    await updateProfile(hostId, changes);
    if (replacementPassword) await replaceStoredPassword(hostId, replacementPassword);
    if (endpointChanged || replacementPassword) {
      removeHostSessions(hostId);
      resetHostHealth(hostId);
    }
  };
  const switchTo = (hostId: string, id: string) => {
    git.closeDiff();
    void activateHost(hostId);
    switchTerminal(hostId, id);
  };
  const newTerminal = () => {
    setActivePresentationId(null);
    createTerminal();
  };
  const selectTerminal = (hostId: string, id: string) => {
    setActivePresentationId(null);
    switchTo(hostId, id);
  };
  const { deepLinkNotice, dismissDeepLinkNotice } = useDeepLinks({
    profiles: profiles ?? null,
    onSession: selectTerminal,
  });
  const selectPresentation = (id: string) => {
    file.closeFile();
    git.closeDiff();
    setActivePresentationId(id);
  };
  usePresentationPoll(isConfiguring, refreshPresentations, serverIp, port);
  const transcript = useTranscriptSelection({
    searchQuery: ui.searchQuery,
    terminalViewRef,
    getTerminalSelection,
    getSessionEntry,
    getActiveSessionId,
    sendPaste,
    setMenuOpen: ui.setMenuOpen,
    setSearchQuery: ui.setSearchQuery,
    setSelectionViewOpen: ui.setSelectionViewOpen,
  });

  const { width: windowWidth } = useWindowDimensions();
  const desktopGitDrawer = desktopLayout(isDesktop, windowWidth) === 'desktop';
  useDesktopEffects({
    isConfiguring,
    presentations,
    activePresentationId,
    fileViewOpen: !!file.fileView,
    diffOpen: git.diffOpen && !desktopGitDrawer,
    getSessionEntry,
    getActiveSessionId,
    getTerminalSelection,
    inputRef,
    sendKey,
    sendPaste,
    handlePaste: transcript.handlePaste,
    selectAllTerminal: transcript.selectAllTerminal,
    newTerminal,
    changeFontSize,
    setContextMenu: ui.setCtxMenu,
    setWindowFocused,
    isWindowFocused,
    refreshSocketActivity,
    activePromptReturnCount: git.activeEntry.term.promptReturnCount,
  });

  const { upPct, upLabel } = updateProgressLabel(updater.updateProgress);
  const openRename = () => {
    ui.setRenameText(drawerSessions.find((s) => s.id === activeId)?.name || '');
    ui.setMenuOpen(false);
    ui.setRenameModalOpen(true);
  };
  const submitRename = async () => {
    const id = activeId;
    const name = ui.renameText.trim();
    ui.setRenameModalOpen(false);
    try {
      await activeClient.post('/api/sessions/rename', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name }),
      });
      await refreshSessions();
    } catch (err) {
      void notify('Rename failed', String(err), 'error');
    }
  };
  const hardResetSession = async () => {
    const ok = await confirmAction(
      'Restart terminal',
      "This restarts the shell process and clears this terminal's scrollback history on the server. This can't be undone.",
      { confirmLabel: 'Restart', destructive: true },
    );
    if (!ok) return;
    resetTerminal();
    try {
      await activeClient.post('/api/sessions/kill', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: activeId }),
      });
      restartActiveSession();
    } catch {
      void notify('Error', 'Failed to kill session on the server', 'error');
    }
  };
  const titleBarStatus: 'connected' | 'connecting' | 'auth-failed' | 'offline' =
    connectionStatus === 'connected'
      ? 'connected'
      : connectionStatus === 'connecting'
        ? 'connecting'
        : connectionStatus === 'auth-failed'
          ? 'auth-failed'
          : 'offline';
  const { activeEntry, ...gitFields } = git;
  const activeSession = drawerSessions.find((s) => s.id === activeId);
  const activeName = activeSession ? sessionLabel(activeSession) : activeId;
  const activePresentation =
    presentations.find((preview) => preview.id === activePresentationId) || null;

  return {
    fontsLoaded,
    insets,
    client: activeClient,
    serverIp,
    setServerIp,
    port,
    setPort,
    password,
    setPassword,
    passwordRef,
    setupMode,
    setSetupMode,
    confirmPassword,
    setConfirmPassword,
    testStatus,
    setTestStatus,
    isConfiguring,
    setIsConfiguring,
    profiles,
    storeError,
    loadProfiles,
    openAddHost,
    openEditHost,
    removeHost,
    saveHostConnection,
    updateProfile,
    reorderHosts,
    clientFor,
    serverSettingsHost,
    serverSettingsClient,
    serverSettingsOpen: serverSettingsHostId !== null && !isConfiguring,
    openServerSettings: (hostId: string) => {
      setServerSettingsHostId(hostId);
      setIsConfiguring(true);
    },
    closeServerSettings: () => setServerSettingsHostId(null),
    saveServerIdentity: (identity: { name: string; color: string }) =>
      serverSettingsHostId ? updateIdentity(serverSettingsHostId, identity) : Promise.resolve(),
    saveHostIdentity: updateIdentity,
    replaceStoredPassword,
    connectionStatus,
    hasConnected,
    mouseEnabled,
    toggleMouseEnabled,
    notificationsEnabled,
    toggleNotificationsEnabled,
    testNotification,
    ...ui,
    ...updater,
    ctrlArmed,
    setCtrlArmed,
    snippets,
    setSnippets,
    activeId,
    activeHostId,
    sidebarPinned,
    persistSidebarPinned,
    drawerSessions,
    healthByHost,
    deepLinkNotice,
    dismissDeepLinkNotice,
    presentations,
    activePresentation,
    activePresentationId,
    ...file,
    ...gitFields,
    selectTerminal,
    selectPresentation,
    closePresentation,
    refreshPresentations,
    refreshHost,
    inputRef,
    fontSize,
    setFontSize,
    lineHeight,
    entryFor,
    terminalViewRef,
    hydrateRenderer,
    onRendererResize,
    onRendererSelection,
    onPageControl,
    onPageReply,
    onPageClipboardWrite,
    wsSend,
    resetTerminal,
    switchTo,
    newTerminal,
    killActiveOr,
    changeFontSize,
    persistSnippets,
    addSnippet,
    removeSnippet,
    sendSnippet,
    refreshSessions,
    testConnection,
    saveConfig,
    sendTyped,
    sendKey,
    sendPaste,
    sendProgram,
    cursorSeq,
    ...transcript,
    activeName,
    activeBellCount: activeEntry.term.bellCount,
    upPct,
    upLabel,
    openRename,
    submitRename,
    hardResetSession,
    titleBarStatus,
    uploadFile,
    pickAndUploadImage,
    fontFamily,
    changeFontFamily,
  };
}
