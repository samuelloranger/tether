import { sessionLabel } from '../sessionLabel';
import { titleBarStatus } from './tetherAppActions';
import type {
  useServerSettingsHost,
  useTetherAppChrome,
  useTetherAppOverlay,
  useTetherAppWorkspace,
} from './tetherAppHooks';
import type { useConnectionConfig } from './useConnectionConfig';
import type { usePresentations } from './usePresentations';
import type { useTerminalSessions } from './useTerminalSessions';

type Parts = {
  chrome: ReturnType<typeof useTetherAppChrome>;
  connection: ReturnType<typeof useConnectionConfig>;
  sessions: ReturnType<typeof useTerminalSessions>;
  presentations: ReturnType<typeof usePresentations>;
  workspace: ReturnType<typeof useTetherAppWorkspace>;
  overlay: ReturnType<typeof useTetherAppOverlay>;
  serverSettings: ReturnType<typeof useServerSettingsHost>;
  updaterLabel: { upPct: number; upLabel: string };
};

function chromePublic(parts: Parts) {
  const viewport = parts.chrome.viewport;
  return {
    fontsLoaded: parts.chrome.fontsLoaded,
    insets: parts.chrome.insets,
    ...parts.chrome.ui,
    ...parts.chrome.updater,
    mouseEnabled: viewport.mouseEnabled,
    toggleMouseEnabled: viewport.toggleMouseEnabled,
    notificationsEnabled: viewport.notificationsEnabled,
    toggleNotificationsEnabled: viewport.toggleNotificationsEnabled,
    testNotification: viewport.testNotification,
    fontSize: viewport.fontSize,
    setFontSize: viewport.setFontSize,
    lineHeight: viewport.lineHeight,
    changeFontSize: viewport.changeFontSize,
    fontFamily: viewport.fontFamily,
    changeFontFamily: viewport.changeFontFamily,
    upPct: parts.updaterLabel.upPct,
    upLabel: parts.updaterLabel.upLabel,
  };
}

function connectionPublic(parts: Parts) {
  const c = parts.connection;
  const s = parts.serverSettings;
  const a = parts.overlay.actions;
  return {
    serverIp: c.serverIp,
    setServerIp: c.setServerIp,
    port: c.port,
    setPort: c.setPort,
    password: c.password,
    setPassword: c.setPassword,
    passwordRef: c.passwordRef,
    setupMode: c.setupMode,
    setSetupMode: c.setSetupMode,
    confirmPassword: c.confirmPassword,
    setConfirmPassword: c.setConfirmPassword,
    testStatus: c.testStatus,
    setTestStatus: c.setTestStatus,
    isConfiguring: c.isConfiguring,
    setIsConfiguring: c.setIsConfiguring,
    profiles: c.profiles,
    storeError: c.storeError,
    loadProfiles: c.loadProfiles,
    openAddHost: c.openAddHost,
    openEditHost: c.openEditHost,
    removeHost: a.removeHost,
    saveHostConnection: a.saveHostConnection,
    updateProfile: c.updateProfile,
    reorderHosts: c.reorderHosts,
    clientFor: c.clientFor,
    serverSettingsHost: s.serverSettingsHost,
    serverSettingsClient: s.serverSettingsClient,
    serverSettingsOpen: s.serverSettingsOpen,
    openServerSettings: s.openServerSettings,
    closeServerSettings: s.closeServerSettings,
    saveServerIdentity: a.saveServerIdentity,
    saveHostIdentity: c.updateIdentity,
    replaceStoredPassword: c.replaceStoredPassword,
    testConnection: c.testConnection,
    saveConfig: a.saveConfig,
  };
}

function sessionPublic(parts: Parts) {
  const s = parts.sessions;
  const w = parts.workspace;
  const a = parts.overlay.actions;
  return {
    client: s.activeClient,
    connectionStatus: s.connectionStatus,
    hasConnected: s.hasConnected,
    ctrlArmed: w.input.ctrlArmed,
    setCtrlArmed: w.input.setCtrlArmed,
    snippets: w.prefs.snippets,
    setSnippets: w.prefs.setSnippets,
    activeId: s.activeId,
    activeHostId: s.activeHostId,
    sidebarPinned: w.prefs.sidebarPinned,
    persistSidebarPinned: w.prefs.persistSidebarPinned,
    drawerSessions: s.drawerSessions,
    healthByHost: s.healthByHost,
    inputRef: w.inputRef,
    entryFor: s.entryFor,
    terminalViewRef: s.terminalViewRef,
    hydrateRenderer: s.hydrateRenderer,
    onRendererResize: s.onRendererResize,
    onRendererSelection: s.onRendererSelection,
    onPageControl: s.onPageControl,
    onPageReply: s.onPageReply,
    onPageClipboardWrite: s.onPageClipboardWrite,
    wsSend: s.wsSend,
    resetTerminal: s.resetTerminal,
    switchTo: a.switchTo,
    newTerminal: a.newTerminal,
    killActiveOr: s.killActiveOr,
    persistSnippets: w.prefs.persistSnippets,
    addSnippet: a.addSnippet,
    removeSnippet: a.removeSnippet,
    sendSnippet: a.sendSnippet,
    refreshSessions: s.refreshSessions,
    sendTyped: w.input.sendTyped,
    sendKey: w.input.sendKey,
    sendPaste: w.input.sendPaste,
    sendProgram: w.input.sendProgram,
    cursorSeq: w.input.cursorSeq,
    refreshHost: s.refreshHost,
    uploadFile: w.upload.uploadFile,
    pickAndUploadImage: w.upload.pickAndUploadImage,
  };
}

function featurePublic(parts: Parts) {
  const { activeEntry, ...gitFields } = parts.workspace.git;
  const activeSession = parts.sessions.drawerSessions.find((s) => s.id === parts.sessions.activeId);
  const pres = parts.presentations;
  return {
    deepLinkNotice: parts.overlay.deepLinks.deepLinkNotice,
    dismissDeepLinkNotice: parts.overlay.deepLinks.dismissDeepLinkNotice,
    presentations: pres.presentations,
    activePresentation:
      pres.presentations.find((preview) => preview.id === pres.activePresentationId) || null,
    activePresentationId: pres.activePresentationId,
    ...parts.workspace.file,
    ...gitFields,
    selectTerminal: parts.overlay.actions.selectTerminal,
    selectPresentation: parts.overlay.actions.selectPresentation,
    closePresentation: pres.closePresentation,
    refreshPresentations: pres.refreshPresentations,
    ...parts.overlay.transcript,
    activeName: activeSession ? sessionLabel(activeSession) : parts.sessions.activeId,
    activeBellCount: activeEntry.term.bellCount,
    openRename: parts.overlay.actions.openRename,
    submitRename: parts.overlay.actions.submitRename,
    hardResetSession: parts.overlay.actions.hardResetSession,
    titleBarStatus: titleBarStatus(parts.sessions.connectionStatus),
  };
}

export function tetherAppPublic(parts: Parts) {
  return {
    ...chromePublic(parts),
    ...connectionPublic(parts),
    ...sessionPublic(parts),
    ...featurePublic(parts),
  };
}
