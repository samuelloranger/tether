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

export function addSnippet(d: TetherActionDeps) {
  const snippet = d.snippetDraft.trim();
  if (!snippet) return;
  d.persistSnippets([...d.snippets, snippet]);
  d.setSnippetDraft('');
}

export function removeSnippet(d: TetherActionDeps, index: number) {
  d.persistSnippets(d.snippets.filter((_, itemIndex) => itemIndex !== index));
}

export function sendSnippet(d: TetherActionDeps, snippet: string) {
  d.setSnippetsModalOpen(false);
  d.sendPaste(snippet);
}

export async function saveAppConfig(d: TetherActionDeps) {
  const { addressChanged, wasReady } = await d.saveConnectionConfig();
  if (addressChanged && wasReady) d.resetForEndpointChange();
  if (d.configuredActiveHostId) d.resetHostHealth(d.configuredActiveHostId);
}

export async function removeAppHost(d: TetherActionDeps, hostId: string) {
  await d.unregisterPushFromHost(hostId);
  d.removeHostSessions(hostId);
  await d.removeConfiguredHost(hostId);
}

export async function saveHostConnection(
  d: TetherActionDeps,
  hostId: string,
  changes: { host: string; port: string },
  replacementPassword?: string,
) {
  const current = d.profiles?.find((profile) => profile.id === hostId);
  if (!current) return;
  const endpointChanged = current.host !== changes.host || current.port !== changes.port;
  await d.updateProfile(hostId, changes);
  if (replacementPassword) await d.replaceStoredPassword(hostId, replacementPassword);
  if (endpointChanged || replacementPassword) {
    d.removeHostSessions(hostId);
    d.resetHostHealth(hostId);
  }
}

export function switchTo(d: TetherActionDeps, hostId: string, id: string) {
  d.closeDiff();
  void d.activateHost(hostId);
  d.switchTerminal(hostId, id);
}

export function newTerminal(d: TetherActionDeps) {
  d.setActivePresentationId(null);
  d.createTerminal();
}

export function selectTerminal(d: TetherActionDeps, hostId: string, id: string) {
  d.setActivePresentationId(null);
  switchTo(d, hostId, id);
}

export function selectPresentation(d: TetherActionDeps, id: string) {
  d.closeFile();
  d.closeDiff();
  d.setActivePresentationId(id);
}

export function openRename(d: TetherActionDeps) {
  d.setRenameText(d.drawerSessions.find((s) => s.id === d.activeId)?.name || '');
  d.setMenuOpen(false);
  d.setRenameModalOpen(true);
}

export async function submitRename(d: TetherActionDeps) {
  const id = d.activeId;
  const name = d.renameText.trim();
  d.setRenameModalOpen(false);
  try {
    await d.activeClient.post('/api/sessions/rename', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    await d.refreshSessions();
  } catch (err) {
    void notify('Rename failed', String(err), 'error');
  }
}

export async function hardResetSession(d: TetherActionDeps) {
  const ok = await confirmAction(
    'Restart terminal',
    "This restarts the shell process and clears this terminal's scrollback history on the server. This can't be undone.",
    { confirmLabel: 'Restart', destructive: true },
  );
  if (!ok) return;
  d.resetTerminal();
  try {
    await d.activeClient.post('/api/sessions/kill', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: d.activeId }),
    });
    d.restartActiveSession();
  } catch {
    void notify('Error', 'Failed to kill session on the server', 'error');
  }
}

export function saveServerIdentity(d: TetherActionDeps, identity: { name: string; color: string }) {
  return d.serverSettingsHostId
    ? d.updateIdentity(d.serverSettingsHostId, identity)
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

export function bindTetherActions(d: TetherActionDeps) {
  return {
    addSnippet: () => addSnippet(d),
    removeSnippet: (index: number) => removeSnippet(d, index),
    sendSnippet: (snippet: string) => sendSnippet(d, snippet),
    saveConfig: () => saveAppConfig(d),
    removeHost: (hostId: string) => removeAppHost(d, hostId),
    saveHostConnection: (
      hostId: string,
      changes: { host: string; port: string },
      replacementPassword?: string,
    ) => saveHostConnection(d, hostId, changes, replacementPassword),
    switchTo: (hostId: string, id: string) => switchTo(d, hostId, id),
    newTerminal: () => newTerminal(d),
    selectTerminal: (hostId: string, id: string) => selectTerminal(d, hostId, id),
    selectPresentation: (id: string) => selectPresentation(d, id),
    openRename: () => openRename(d),
    submitRename: () => submitRename(d),
    hardResetSession: () => hardResetSession(d),
    saveServerIdentity: (identity: { name: string; color: string }) =>
      saveServerIdentity(d, identity),
  };
}
