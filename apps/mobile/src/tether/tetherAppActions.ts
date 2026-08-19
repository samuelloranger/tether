import { confirmAction, notify } from '../dialog';
import type { HostClient } from './hostClient';
import type { HostProfile } from './hostStore';

export type TetherActionDeps = {
  snippetDraft: string;
  snippets: string[];
  persistSnippets: (next: string[]) => void;
  setSnippetDraft: (value: string) => void;
  setSnippetsModalOpen: (open: boolean) => void;
  sendPaste: (text: string) => void;
  saveConnectionConfig: () => Promise<{ addressChanged: boolean; wasReady: boolean }>;
  resetForEndpointChange: () => void;
  resetHostHealth: (hostId: string) => void;
  configuredActiveHostId: string | null;
  unregisterPushFromHost: (hostId: string) => Promise<void>;
  removeHostSessions: (hostId: string) => void;
  removeConfiguredHost: (hostId: string) => Promise<void>;
  profiles: HostProfile[] | null;
  updateProfile: (
    hostId: string,
    changes: Partial<Omit<HostProfile, 'id' | 'order'>>,
  ) => Promise<void>;
  replaceStoredPassword: (hostId: string, password: string) => Promise<void>;
  closeDiff: () => void;
  closeFile: () => void;
  activateHost: (hostId: string) => Promise<void>;
  switchTerminal: (hostId: string, id: string) => void;
  setActivePresentationId: (id: string | null) => void;
  createTerminal: () => void;
  drawerSessions: { id: string; name?: string | null }[];
  activeId: string;
  setRenameText: (value: string) => void;
  setMenuOpen: (open: boolean) => void;
  setRenameModalOpen: (open: boolean) => void;
  renameText: string;
  activeClient: HostClient;
  refreshSessions: () => Promise<void>;
  resetTerminal: () => void;
  restartActiveSession: () => void;
  updateIdentity: (hostId: string, identity: { name: string; color: string }) => Promise<void>;
  serverSettingsHostId: string | null;
};

export function addSnippet(deps: TetherActionDeps) {
  const snippet = deps.snippetDraft.trim();
  if (!snippet) return;
  deps.persistSnippets([...deps.snippets, snippet]);
  deps.setSnippetDraft('');
}

export function removeSnippet(deps: TetherActionDeps, index: number) {
  deps.persistSnippets(deps.snippets.filter((_, itemIndex) => itemIndex !== index));
}

export function sendSnippet(deps: TetherActionDeps, snippet: string) {
  deps.setSnippetsModalOpen(false);
  deps.sendPaste(snippet);
}

async function saveAppConfig(deps: TetherActionDeps) {
  const { addressChanged, wasReady } = await deps.saveConnectionConfig();
  if (addressChanged && wasReady) deps.resetForEndpointChange();
  if (deps.configuredActiveHostId) deps.resetHostHealth(deps.configuredActiveHostId);
}

async function removeAppHost(deps: TetherActionDeps, hostId: string) {
  await deps.unregisterPushFromHost(hostId);
  deps.removeHostSessions(hostId);
  await deps.removeConfiguredHost(hostId);
}

export async function saveHostConnection(
  deps: TetherActionDeps,
  hostId: string,
  changes: { host: string; port: string },
  replacementPassword?: string,
) {
  const current = deps.profiles?.find((profile) => profile.id === hostId);
  if (!current) return;
  const endpointChanged = current.host !== changes.host || current.port !== changes.port;
  await deps.updateProfile(hostId, changes);
  if (replacementPassword) await deps.replaceStoredPassword(hostId, replacementPassword);
  if (endpointChanged || replacementPassword) {
    deps.removeHostSessions(hostId);
    deps.resetHostHealth(hostId);
  }
}

export function switchTo(deps: TetherActionDeps, hostId: string, id: string) {
  deps.closeDiff();
  void deps.activateHost(hostId);
  deps.switchTerminal(hostId, id);
}

export function newTerminal(deps: TetherActionDeps) {
  deps.setActivePresentationId(null);
  deps.createTerminal();
}

export function selectTerminal(deps: TetherActionDeps, hostId: string, id: string) {
  deps.setActivePresentationId(null);
  switchTo(deps, hostId, id);
}

export function selectPresentation(deps: TetherActionDeps, id: string) {
  deps.closeFile();
  deps.closeDiff();
  deps.setActivePresentationId(id);
}

export function openRename(deps: TetherActionDeps) {
  deps.setRenameText(deps.drawerSessions.find((s) => s.id === deps.activeId)?.name || '');
  deps.setMenuOpen(false);
  deps.setRenameModalOpen(true);
}

export async function submitRename(deps: TetherActionDeps) {
  const id = deps.activeId;
  const name = deps.renameText.trim();
  deps.setRenameModalOpen(false);
  try {
    await deps.activeClient.post('/api/sessions/rename', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    await deps.refreshSessions();
  } catch (err) {
    void notify('Rename failed', String(err), 'error');
  }
}

export async function hardResetSession(deps: TetherActionDeps) {
  const ok = await confirmAction(
    'Restart terminal',
    "This restarts the shell process and clears this terminal's scrollback history on the server. This can't be undone.",
    { confirmLabel: 'Restart', destructive: true },
  );
  if (!ok) return;
  deps.resetTerminal();
  try {
    await deps.activeClient.post('/api/sessions/kill', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: deps.activeId }),
    });
    deps.restartActiveSession();
  } catch {
    void notify('Error', 'Failed to kill session on the server', 'error');
  }
}

export function saveServerIdentity(
  deps: TetherActionDeps,
  identity: { name: string; color: string },
) {
  return deps.serverSettingsHostId
    ? deps.updateIdentity(deps.serverSettingsHostId, identity)
    : Promise.resolve();
}

export function titleBarStatus(
  connectionStatus: string,
): 'connected' | 'connecting' | 'auth-failed' | 'offline' {
  if (connectionStatus === 'connected') return 'connected';
  if (connectionStatus === 'connecting') return 'connecting';
  if (connectionStatus === 'auth-failed') return 'auth-failed';
  return 'offline';
}

export function bindTetherActions(deps: TetherActionDeps) {
  return {
    addSnippet: () => addSnippet(deps),
    removeSnippet: (index: number) => removeSnippet(deps, index),
    sendSnippet: (snippet: string) => sendSnippet(deps, snippet),
    saveConfig: () => saveAppConfig(deps),
    removeHost: (hostId: string) => removeAppHost(deps, hostId),
    saveHostConnection: (
      hostId: string,
      changes: { host: string; port: string },
      replacementPassword?: string,
    ) => saveHostConnection(deps, hostId, changes, replacementPassword),
    switchTo: (hostId: string, id: string) => switchTo(deps, hostId, id),
    newTerminal: () => newTerminal(deps),
    selectTerminal: (hostId: string, id: string) => selectTerminal(deps, hostId, id),
    selectPresentation: (id: string) => selectPresentation(deps, id),
    openRename: () => openRename(deps),
    submitRename: () => submitRename(deps),
    hardResetSession: () => hardResetSession(deps),
    saveServerIdentity: (identity: { name: string; color: string }) =>
      saveServerIdentity(deps, identity),
  };
}
