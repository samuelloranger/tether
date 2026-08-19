import { sessionLabel } from '../../sessionLabel';
import { titleBarStatus } from '../tetherAppActions';
import type { TetherParts } from './parts';

// Each build* returns ONE domain's value. These were previously spread into a
// single 105-key object; keeping them separate is the whole point — a component
// that needs sessions must not thereby depend on git, presentations, or config.

export function buildChrome(p: TetherParts) {
  const v = p.chrome.viewport;
  return {
    fontsLoaded: p.chrome.fontsLoaded,
    insets: p.chrome.insets,
    theme: p.chrome.theme,
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
  };
}

export function buildUpdater(p: TetherParts) {
  const u = p.chrome.updater;
  return {
    updateInfo: u.updateInfo,
    updating: u.updating,
    startUpdate: u.startUpdate,
    downloadUpdate: u.downloadUpdate,
    dismissUpdate: u.dismissUpdate,
    checkForUpdatesManual: u.checkForUpdatesManual,
    upPct: p.updaterLabel.upPct,
    upLabel: p.updaterLabel.upLabel,
  };
}

export function buildConnection(p: TetherParts) {
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
    updateProfile: c.updateProfile,
    reorderHosts: c.reorderHosts,
    clientFor: c.clientFor,
    replaceStoredPassword: c.replaceStoredPassword,
    testConnection: c.testConnection,
    saveHostIdentity: c.updateIdentity,
    removeHost: a.removeHost,
    saveHostConnection: a.saveHostConnection,
    saveServerIdentity: a.saveServerIdentity,
    saveConfig: a.saveConfig,
    serverSettingsHost: s.serverSettingsHost,
    serverSettingsClient: s.serverSettingsClient,
    serverSettingsOpen: s.serverSettingsOpen,
    openServerSettings: s.openServerSettings,
    closeServerSettings: s.closeServerSettings,
  };
}

function sessionIdentity(p: TetherParts) {
  const active = p.sessions.drawerSessions.find((s) => s.id === p.sessions.activeId);
  return {
    activeName: active ? sessionLabel(active) : p.sessions.activeId,
    activeBellCount: p.workspace.git.activeEntry.term.bellCount,
    titleBarStatus: titleBarStatus(p.sessions.connectionStatus),
  };
}

function sessionInput(p: TetherParts) {
  const i = p.workspace.input;
  return {
    ctrlArmed: i.ctrlArmed,
    setCtrlArmed: i.setCtrlArmed,
    sendTyped: i.sendTyped,
    sendKey: i.sendKey,
    sendPaste: i.sendPaste,
    sendProgram: i.sendProgram,
    cursorSeq: i.cursorSeq,
    inputRef: p.workspace.inputRef,
  };
}

function sessionPrefs(p: TetherParts) {
  const pr = p.workspace.prefs;
  const a = p.overlay.actions;
  return {
    snippets: pr.snippets,
    setSnippets: pr.setSnippets,
    persistSnippets: pr.persistSnippets,
    sidebarPinned: pr.sidebarPinned,
    persistSidebarPinned: pr.persistSidebarPinned,
    addSnippet: a.addSnippet,
    removeSnippet: a.removeSnippet,
    sendSnippet: a.sendSnippet,
  };
}

function sessionRenderer(p: TetherParts) {
  const s = p.sessions;
  return {
    entryFor: s.entryFor,
    terminalViewRef: s.terminalViewRef,
    hydrateRenderer: s.hydrateRenderer,
    onRendererResize: s.onRendererResize,
    onRendererSelection: s.onRendererSelection,
    onPageControl: s.onPageControl,
    onPageReply: s.onPageReply,
    onPageClipboardWrite: s.onPageClipboardWrite,
    wsSend: s.wsSend,
  };
}

export function buildSession(p: TetherParts) {
  const s = p.sessions;
  const a = p.overlay.actions;
  return {
    client: s.activeClient,
    connectionStatus: s.connectionStatus,
    hasConnected: s.hasConnected,
    activeId: s.activeId,
    activeHostId: s.activeHostId,
    drawerSessions: s.drawerSessions,
    healthByHost: s.healthByHost,
    resetTerminal: s.resetTerminal,
    killActiveOr: s.killActiveOr,
    refreshSessions: s.refreshSessions,
    refreshHost: s.refreshHost,
    switchTo: a.switchTo,
    newTerminal: a.newTerminal,
    openRename: a.openRename,
    submitRename: a.submitRename,
    hardResetSession: a.hardResetSession,
    uploadFile: p.workspace.upload.uploadFile,
    pickAndUploadImage: p.workspace.upload.pickAndUploadImage,
    ...sessionIdentity(p),
    ...sessionInput(p),
    ...sessionPrefs(p),
    ...sessionRenderer(p),
  };
}

export function buildGit(p: TetherParts) {
  // activeEntry stays out: it is the raw session entry, exposed through the
  // session domain as activeBellCount rather than handed around whole.
  const { activeEntry: _activeEntry, ...git } = p.workspace.git;
  return git;
}

export function buildPresentation(p: TetherParts) {
  const pres = p.presentations;
  const a = p.overlay.actions;
  return {
    presentations: pres.presentations,
    activePresentationId: pres.activePresentationId,
    activePresentation:
      pres.presentations.find((preview) => preview.id === pres.activePresentationId) || null,
    closePresentation: pres.closePresentation,
    refreshPresentations: pres.refreshPresentations,
    selectTerminal: a.selectTerminal,
    selectPresentation: a.selectPresentation,
  };
}

export function buildTranscript(p: TetherParts) {
  return {
    ...p.overlay.transcript,
    deepLinkNotice: p.overlay.deepLinks.deepLinkNotice,
    dismissDeepLinkNotice: p.overlay.deepLinks.dismissDeepLinkNotice,
  };
}
