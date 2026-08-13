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

export function chromePublic(p: Parts) {
  const v = p.chrome.viewport;
  return {
    fontsLoaded: p.chrome.fontsLoaded,
    insets: p.chrome.insets,
    ...p.chrome.ui,
    ...p.chrome.updater,
    mouseEnabled: v.mouseEnabled,
    toggleMouseEnabled: v.toggleMouseEnabled,
    notificationsEnabled: v.notificationsEnabled,
    toggleNotificationsEnabled: v.toggleNotificationsEnabled,
    testNotification: v.testNotification,
    fontSize: v.fontSize,
    setFontSize: v.setFontSize,
    lineHeight: v.lineHeight,
    changeFontSize: v.changeFontSize,
    fontFamily: v.fontFamily,
    changeFontFamily: v.changeFontFamily,
    upPct: p.updaterLabel.upPct,
    upLabel: p.updaterLabel.upLabel,
  };
}

export function connectionPublic(p: Parts) {
  const c = p.connection;
  const s = p.serverSettings;
  const a = p.overlay.actions;
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

export function sessionPublic(p: Parts) {
  const s = p.sessions;
  const w = p.workspace;
  const a = p.overlay.actions;
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

export function featurePublic(p: Parts) {
  const { activeEntry, ...gitFields } = p.workspace.git;
  const activeSession = p.sessions.drawerSessions.find((s) => s.id === p.sessions.activeId);
  const pres = p.presentations;
  return {
    deepLinkNotice: p.overlay.deepLinks.deepLinkNotice,
    dismissDeepLinkNotice: p.overlay.deepLinks.dismissDeepLinkNotice,
    presentations: pres.presentations,
    activePresentation:
      pres.presentations.find((preview) => preview.id === pres.activePresentationId) || null,
    activePresentationId: pres.activePresentationId,
    ...p.workspace.file,
    ...gitFields,
    selectTerminal: p.overlay.actions.selectTerminal,
    selectPresentation: p.overlay.actions.selectPresentation,
    closePresentation: pres.closePresentation,
    refreshPresentations: pres.refreshPresentations,
    ...p.overlay.transcript,
    activeName: activeSession ? sessionLabel(activeSession) : p.sessions.activeId,
    activeBellCount: activeEntry.term.bellCount,
    openRename: p.overlay.actions.openRename,
    submitRename: p.overlay.actions.submitRename,
    hardResetSession: p.overlay.actions.hardResetSession,
    titleBarStatus: titleBarStatus(p.sessions.connectionStatus),
  };
}

export function tetherAppPublic(p: Parts) {
  return {
    ...chromePublic(p),
    ...connectionPublic(p),
    ...sessionPublic(p),
    ...featurePublic(p),
  };
}
