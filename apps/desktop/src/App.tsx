import { useMemo, useState } from 'react';
import { FileViewer } from './FileViewer';
import { HostFormScreen } from './HostFormScreen';
import { HostsScreen } from './HostsScreen';
import { PresentationBanner, PresentationView } from './PresentationView';
import { loadPreferences, UI_THEMES } from './preferences';
import { SessionDrawer } from './SessionDrawer';
import { SettingsScreen } from './SettingsScreen';
import { hostSecrets } from './secureConfig';
import { TerminalPane } from './TerminalPane';
import { httpOriginFor, wsOriginFor } from './types';
import { useTetherDesktop } from './useTetherDesktop';
import { useWorkspace, WorkspacePanel } from './useWorkspace';

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: root shell routes between drawer, terminal, and settings flows
export function App() {
  const app = useTetherDesktop();
  const [prefs, setPrefs] = useState(loadPreferences);
  const theme = UI_THEMES[prefs.theme];
  const httpBase = app.activeHost ? httpOriginFor(app.activeHost) : null;
  const workspace = useWorkspace({
    hostId: app.activeHostId,
    sessionId: app.activeSessionId,
    baseUrl: httpBase,
    enabled: app.ready && app.screen === 'main' && !!app.activeHost,
  });

  const editingHost = useMemo(
    () => app.hosts.find((host) => host.id === app.editingHostId) ?? null,
    [app.hosts, app.editingHostId],
  );

  if (!app.ready) {
    return (
      <div className="app-shell" style={{ background: theme.background, color: theme.text }}>
        <p className="muted boot-message">Loading…</p>
      </div>
    );
  }

  if (app.hosts.length === 0 || app.screen === 'host-form') {
    return (
      <div
        className="app-shell centered"
        style={{ background: theme.background, color: theme.text }}
      >
        <HostFormScreen
          editing={editingHost}
          onCancel={() => {
            if (app.hosts.length === 0) return;
            app.setScreen('main');
            app.setEditingHostId(null);
          }}
          onSave={async (input) => {
            let password = input.password;
            if (input.id && !password) {
              password = (await hostSecrets.get(input.id)) ?? '';
            }
            await app.saveHost({ ...input, password });
          }}
        />
      </div>
    );
  }

  if (app.screen === 'hosts') {
    return (
      <div
        className="app-shell centered"
        style={{ background: theme.background, color: theme.text }}
      >
        <HostsScreen
          hosts={app.hosts}
          healthByHost={app.healthByHost}
          onBack={() => app.setScreen('main')}
          onAdd={() => {
            app.setEditingHostId(null);
            app.setScreen('host-form');
          }}
          onEdit={(hostId) => {
            app.setEditingHostId(hostId);
            app.setScreen('host-form');
          }}
          onRemove={(hostId) => void app.removeHost(hostId)}
          onSelect={app.selectHost}
        />
      </div>
    );
  }

  if (app.screen === 'settings') {
    return (
      <div
        className="app-shell centered"
        style={{ background: theme.background, color: theme.text }}
      >
        <SettingsScreen
          onBack={() => {
            setPrefs(loadPreferences());
            app.setScreen('main');
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="app-shell"
      style={{
        background: theme.background,
        color: theme.text,
        ['--surface' as string]: theme.surface,
        ['--border' as string]: theme.border,
        ['--text-muted' as string]: theme.textMuted,
        ['--accent' as string]: theme.accent,
        ['--danger' as string]: theme.danger,
        ['--success' as string]: theme.success,
        ['--warning' as string]: theme.warning,
      }}
    >
      <SessionDrawer
        hosts={app.hosts}
        healthByHost={app.healthByHost}
        sessions={app.sessions}
        activeHostId={app.activeHostId}
        activeSessionId={app.activeSessionId}
        onSelect={app.selectSession}
        onNew={app.newSession}
        onKill={app.killSessionById}
        onRename={app.renameSessionById}
        onRetryHost={app.retryHost}
        onReenterPassword={(hostId) => {
          app.setEditingHostId(hostId);
          app.setScreen('host-form');
        }}
        onOpenHosts={() => app.setScreen('hosts')}
        onOpenSettings={() => app.setScreen('settings')}
      />
      <main className="main-pane">
        {app.activeHost ? (
          <>
            <header className="terminal-toolbar">
              <span className="terminal-label">{app.activeSessionLabel}</span>
              <button
                type="button"
                className="secondary small"
                onClick={() => workspace.setWorkspaceOpen(true)}
              >
                Workspace
              </button>
              <button
                type="button"
                className="secondary small"
                onClick={() => void workspace.pickAndUpload()}
              >
                Upload
              </button>
              <span className="terminal-host-label muted">
                {app.activeHost.name} · {app.activeHost.host}:{app.activeHost.port}
              </span>
            </header>
            {workspace.sessionPreview && !workspace.activePresentation && !workspace.fileView && (
              <PresentationBanner
                label={`Preview ready: ${workspace.sessionPreview.title}`}
                onPress={() => {
                  const preview = workspace.sessionPreview;
                  if (preview) workspace.setActivePresentationId(preview.id);
                }}
              />
            )}
            <div className="main-body">
              {workspace.workspaceOpen && <WorkspacePanel workspace={workspace} />}
              <div className="terminal-stack">
                <TerminalPane
                  key={`${app.terminalKey}:${prefs.theme}:${prefs.terminalFont}`}
                  hostId={app.activeHost.id}
                  sessionId={app.activeSessionId}
                  wsOrigin={wsOriginFor(app.activeHost)}
                  password={app.activePassword}
                  terminalTheme={theme.terminal}
                  fontFamily={prefs.terminalFont}
                  onFrame={app.handleWsFrame}
                  onDisconnected={() => {
                    if (app.activeHostId) app.retryHost(app.activeHostId);
                  }}
                />
                {workspace.fileLoading && (
                  <div className="workspace-cover muted">Loading file…</div>
                )}
                {workspace.uploading && <div className="workspace-cover muted">Uploading…</div>}
                {workspace.fileView && (
                  <FileViewer
                    file={workspace.fileView}
                    onBack={workspace.closeFile}
                    theme={theme}
                    backLabel={app.activeSessionLabel}
                  />
                )}
                {workspace.activePresentation && workspace.activePresentationUrl && (
                  <PresentationView
                    preview={workspace.activePresentation}
                    url={workspace.activePresentationUrl}
                    backLabel={app.activeSessionLabel}
                    onBack={() => workspace.setActivePresentationId(null)}
                    onClose={() => {
                      const preview = workspace.activePresentation;
                      if (preview) void workspace.closePresentation(preview.id);
                    }}
                  />
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-main">
            <p>Select a host to connect.</p>
            <button type="button" onClick={() => app.setScreen('hosts')}>
              Manage hosts
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
