// biome-ignore-all lint/style/noExcessiveLinesPerFile: root app shell — routes every screen and wires the drawer, terminal panes, git, and workspace panels
import { useEffect, useMemo, useRef, useState } from 'react';
import { type DrawerSession, type HostHealthStatus, httpOriginFor } from '@/core/types';
import { DevicesScreen } from '@/host/DevicesScreen';
import { HostsScreen } from '@/host/HostsScreen';
import { PairDeviceScreen } from '@/host/PairDeviceScreen';
import type { DropIntent } from '@/pane/dropZone';
import { PanePickerModal } from '@/pane/PanePickerModal';
import { leaves } from '@/pane/paneTree';
import { useViewState } from '@/pane/useViewState';
import type { View } from '@/pane/viewModel';
import { ensureNotificationPermission } from '@/platform/desktopNotifications';
import { useDeepLinks } from '@/platform/useDeepLinks';
import { useLaunchUpdateCheck } from '@/platform/useLaunchUpdateCheck';
import { useWindowTheme } from '@/platform/useWindowTheme';
import { PresentationBanner, PresentationView } from '@/presentations/PresentationView';
import { activeSessionDot, litStateFor, shellVars } from '@/session/litTheme';
import { ResidentTerminals } from '@/session/ResidentTerminals';
import { SessionDrawer } from '@/session/SessionDrawer';
import { SessionModalHost, useSessionModals } from '@/session/SessionModals';
import { SessionChrome } from '@/session/SessionTabBar';
import { sessionKey } from '@/session/sessionKey';
import { useSessionLaunch } from '@/session/useSessionLaunch';
import { useTabDrag } from '@/session/useTabDrag';
import {
  type AppPreferences,
  loadPreferences,
  resolveFlavor,
  savePreferences,
  sidebarLayout,
  UI_THEMES,
} from '@/settings/preferences';
import { ServerSettingsScreen } from '@/settings/ServerSettingsScreen';
import { LocalSettingsScreen } from '@/settings/SettingsScreen';
import { AlertModal } from '@/shell/AlertModal';
import { AppOverflowMenu } from '@/shell/AppOverflowMenu';
import { useShellChrome } from '@/shell/useHeatArrival';
import { useTetherDesktop } from '@/shell/useTetherDesktop';
import { TerminalEmpty } from '@/terminal/TerminalEmpty';
import { FileViewer } from '@/workspace/FileViewer';
import { setFileOpenListener } from '@/workspace/fileOpenBus';
import { useWorkspace, WorkspacePanel } from '@/workspace/useWorkspace';
import { AgentFolderPicker } from './agent/AgentFolderPicker';
import { GitDrawer } from './git/GitDrawer';
import { GitReview } from './git/GitReview';
import { useGitPanel } from './git/useGitPanel';

function useMediaScheme(): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setScheme(mq.matches ? 'light' : 'dark');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return scheme;
}

function useWideLayout(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= 720);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return wide;
}

function liveSessionKeys(
  sessions: DrawerSession[],
  views: View[],
  healthByHost: Record<string, HostHealthStatus>,
): Set<string> {
  const live = new Set(sessions.map((row) => sessionKey(row.hostId, row.id)));
  const known = new Set(
    Object.entries(healthByHost)
      .filter(([, status]) => status !== 'unknown')
      .map(([id]) => id),
  );
  for (const view of views) {
    for (const leaf of leaves(view.tree)) {
      if (!leaf.session) continue;
      if (!known.has(leaf.session.hostId)) {
        live.add(sessionKey(leaf.session.hostId, leaf.session.sessionId));
      }
    }
  }
  return live;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: root shell routes between drawer, terminal, and settings flows
export function App() {
  const app = useTetherDesktop();
  const [prefs, setPrefs] = useState<AppPreferences>(loadPreferences);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Which trigger opened the overflow menu, so the panel can hang on that side.
  const [overflowAlign, setOverflowAlign] = useState<'start' | 'end'>('end');
  const openOverflow = (align: 'start' | 'end') => {
    setOverflowAlign(align);
    setOverflowOpen(true);
  };
  // Nothing to diff or browse without a session: `/api/sessions//diff`.
  const hasSession = !!app.activeSessionId;
  const gitPanel = useGitPanel(app.activeHostId, app.activeSessionId, app.gitOpen && hasSession);
  const httpBase = app.activeHost ? httpOriginFor(app.activeHost) : null;
  const workspace = useWorkspace({
    hostId: app.activeHostId,
    sessionId: app.activeSessionId,
    baseUrl: httpBase,
    enabled: app.ready && app.screen === 'main' && !!app.activeHost && hasSession,
  });
  const openFileRef = useRef(workspace.openFile);
  openFileRef.current = workspace.openFile;
  useEffect(() => {
    setFileOpenListener((path, line, column) => {
      void openFileRef.current(path, line, column);
    });
    return () => setFileOpenListener(null);
  }, []);
  const scheme = useMediaScheme();
  const wide = useWideLayout();
  const flavor = resolveFlavor(prefs.theme, scheme);
  const theme = UI_THEMES[flavor];
  const layout = sidebarLayout({
    wide,
    sidebarPinned: prefs.sidebarPinned,
    drawerOpen,
    tabLayout: prefs.tabLayout,
  });
  const modals = useSessionModals();

  const [panePickerFor, setPanePickerFor] = useState<string | null>(null);
  const viewState = useViewState({
    liveKeysFor: (views) =>
      new Set([...liveSessionKeys(app.sessions, views, app.healthByHost), ...app.pendingAgentKeys()]),
    sessions: app.sessions,
    healthByHost: app.healthByHost,
    onFocusSession: app.selectSession,
  });
  const { tree, focusedPaneId } = viewState;
  const dropSessionIntoPane = (paneId: string, intent: DropIntent, key: string) =>
    viewState.dropIntoPane(paneId, intent, key);
  // Pointer-driven drag: Tauri's native drag-drop handler (kept for OS
  // file-drop upload) swallows in-webview HTML5 DnD on Windows/WebView2.
  const tabDrag = useTabDrag(dropSessionIntoPane);

  const openView = viewState.openView;
  // Drawer click: activate the view that holds this session (and focus its pane).
  const openSession = viewState.openSession;

  const launch = useSessionLaunch({
    app,
    viewState,
    onLaunched: () => {
      if (!layout.docked) setDrawerOpen(false);
    },
  });

  useEffect(() => {
    void ensureNotificationPermission();
  }, []);

  useWindowTheme(flavor);
  useLaunchUpdateCheck();

  useDeepLinks({
    ready: app.ready,
    profiles: app.hosts,
    onSession: openSession,
  });

  const settingsHost = useMemo(
    () => app.hosts.find((host) => host.id === app.settingsHostId) ?? app.activeHost,
    [app.hosts, app.settingsHostId, app.activeHost],
  );

  // Everything tinted in index.css resolves through --lit, so this is what
  // re-colours the app on a session switch. A stopped session tints nothing.
  const { dot: activeDot } = useMemo(
    () => activeSessionDot(app.sessions, app.activeHostId, app.activeSessionId),
    [app.sessions, app.activeHostId, app.activeSessionId],
  );
  const litState = litStateFor(activeDot);

  // A file viewer/presentation owns the pane while up, so git overlays stand
  // down rather than stack — git returns when the viewer closes.
  const fileOrPreviewUp = Boolean(workspace.fileView || workspace.fileLoading || workspace.activePresentation);

  const shellProps = useShellChrome(litState, {
    ...shellVars(theme, litState),
    background: theme.colors.background,
    color: theme.colors.text,
  });

  if (!app.ready) {
    return (
      <div className="app-shell" {...shellProps}>
        <div className="boot-message">
          <span className="boot-mark">tether</span>
          <span className="boot-status">starting</span>
        </div>
      </div>
    );
  }

  if (app.hosts.length === 0 || app.screen === 'pair-device') {
    return (
      <div className="app-shell centered" {...shellProps}>
        <PairDeviceScreen
          onPair={app.pairHost}
          onDone={() => app.setScreen('hosts')}
          onCancel={() => app.setScreen(app.hosts.length > 0 ? 'hosts' : 'main')}
        />
        <AlertModal />
      </div>
    );
  }

  if (app.screen === 'devices' && settingsHost) {
    return (
      <div className="app-shell centered" {...shellProps}>
        <DevicesScreen
          host={settingsHost}
          onBack={() => {
            app.setSettingsHostId(null);
            app.setScreen('hosts');
          }}
        />
        <AlertModal />
      </div>
    );
  }

  if (app.screen === 'hosts') {
    return (
      <div className="app-shell centered" {...shellProps}>
        <HostsScreen
          hosts={app.hosts}
          healthByHost={app.healthByHost}
          onBack={() => app.setScreen('main')}
          onAdd={() => app.setScreen('pair-device')}
          onDevices={(hostId) => {
            app.setSettingsHostId(hostId);
            app.setScreen('devices');
          }}
          onRemove={(hostId) => void app.removeHost(hostId)}
          onSelect={app.selectHost}
        />
        <AlertModal />
      </div>
    );
  }

  if (app.screen === 'local-settings') {
    return (
      <div className="app-shell centered" {...shellProps}>
        <LocalSettingsScreen prefs={prefs} onPrefsChange={setPrefs} onBack={() => app.setScreen('main')} />
        <AlertModal />
      </div>
    );
  }

  if (app.screen === 'settings' && settingsHost) {
    return (
      <div className="app-shell centered" {...shellProps}>
        <ServerSettingsScreen
          host={settingsHost}
          health={app.healthByHost[settingsHost.id] ?? 'unknown'}
          onBack={() => {
            app.setSettingsHostId(null);
            app.setScreen('main');
          }}
          onRetry={() => app.retryHost(settingsHost.id)}
          onIdentitySaved={(identity) => {
            void app.updateHostIdentity(settingsHost.id, identity);
          }}
          onConnectionSaved={async (changes) => {
            await app.updateHostConnection(settingsHost.id, changes);
          }}
          onRemoveHost={async () => {
            await app.removeHost(settingsHost.id);
          }}
        />
        <AlertModal />
      </div>
    );
  }

  return (
    <div className="app-shell" {...shellProps}>
      {layout.showMenuButton ? (
        <button
          type="button"
          className="drawer-menu-button"
          aria-label="Open sessions"
          onClick={() => setDrawerOpen(true)}
        >
          ☰
        </button>
      ) : null}
      {layout.visible ? (
        <>
          {!layout.docked ? (
            <button
              type="button"
              className="drawer-scrim"
              aria-label="Close sessions"
              onClick={() => setDrawerOpen(false)}
            />
          ) : null}
          <SessionDrawer
            hosts={app.hosts}
            healthByHost={app.healthByHost}
            sessions={app.sessions}
            activeHostId={app.activeHostId}
            activeSessionId={app.activeSessionId}
            docked={layout.docked}
            showPin={wide}
            sidebarPinned={prefs.sidebarPinned}
            onTogglePin={() => {
              const next = { ...prefs, sidebarPinned: !prefs.sidebarPinned };
              savePreferences(next);
              setPrefs(next);
              if (prefs.sidebarPinned) setDrawerOpen(false);
            }}
            onSelect={(hostId, sessionId) => {
              openSession(hostId, sessionId);
              if (!layout.docked) setDrawerOpen(false);
            }}
            onNew={launch.newTerminalOn}
            onNewAgentChat={launch.newAgentChatOn}
            onRequestKill={modals.openKill}
            onRequestRename={modals.openRename}
            onRetryHost={app.retryHost}
            onOpenHosts={() => app.setScreen('hosts')}
            onOpenSettings={() => openOverflow('start')}
            onOpenHostSettings={(hostId) => {
              app.setSettingsHostId(hostId);
              app.setScreen('settings');
            }}
            onSplitFromTab={viewState.splitFromTab}
            onBeginDrag={tabDrag.begin}
          />
        </>
      ) : null}
      <main className="main-pane">
        {app.activeHost ? (
          <>
            <SessionChrome
              showTabBar={layout.showTabBar}
              inset={layout.showMenuButton}
              app={app}
              views={viewState.views}
              activeViewId={viewState.activeViewId}
              dot={activeDot}
              hasSession={hasSession}
              onNew={launch.newTerminalOn}
              onNewAgentChat={launch.newAgentChatOn}
              onKill={modals.openKill}
              onKillMembers={modals.openKillMembers}
              onWorkspace={() => workspace.setWorkspaceOpen(true)}
              onUpload={() => void workspace.pickAndUpload()}
              onOverflow={() => openOverflow('end')}
              onSplitFromTab={viewState.splitFromTab}
              onSelectView={openView}
              onBeginDrag={tabDrag.begin}
            />
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
                <div className="screen">
                  <TerminalEmpty
                    open={!hasSession}
                    hostName={app.activeHost.name}
                    onNew={() => launch.newTerminalOn(app.activeHostId)}
                  />
                  <ResidentTerminals
                    hosts={app.hosts}
                    sessions={app.sessions}
                    tree={tree}
                    focusedPaneId={focusedPaneId}
                    lruOrder={viewState.lruOrder}
                    terminalTheme={theme.terminal}
                    fontFamily={prefs.terminalFont}
                    onFrame={app.handleWsFrame}
                    onDisconnected={(hostId) => app.retryHost(hostId)}
                    onResumeSession={launch.resumeAgentChat}
                    onFocusPane={viewState.focusPane}
                    onSetRatio={viewState.setPaneRatio}
                    onPickSession={(paneId) => setPanePickerFor(paneId)}
                    onSplit={viewState.splitPane}
                    onClosePane={viewState.closePane}
                    preview={tabDrag.drag?.target ?? null}
                  />
                </div>
                {app.gitOpen && !fileOrPreviewUp && app.gitMode === 'drawer' ? (
                  <GitDrawer panel={gitPanel} onClose={() => app.setGitOpen(false)} />
                ) : null}
                {app.gitOpen && !fileOrPreviewUp && app.gitMode === 'review' && app.activeHostId ? (
                  <GitReview
                    panel={gitPanel}
                    hostId={app.activeHostId}
                    sessionId={app.activeSessionId}
                    onClose={() => app.setGitOpen(false)}
                  />
                ) : null}
                {workspace.fileLoading && <div className="workspace-cover muted">Loading file…</div>}
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

      {tabDrag.drag && (
        <div className="tab-drag-ghost" style={{ left: tabDrag.drag.x, top: tabDrag.drag.y }} aria-hidden>
          {tabDrag.drag.label}
        </div>
      )}

      <SessionModalHost
        modals={modals}
        onRename={(hostId, sessionId, name) => void app.renameSessionById(hostId, sessionId, name)}
        onKill={(hostId, sessionId) => void app.killSessionById(hostId, sessionId)}
      />
      {panePickerFor && (
        <PanePickerModal
          hosts={app.hosts}
          sessions={app.sessions.filter((row) => !viewState.openSessionKeys.has(sessionKey(row.hostId, row.id)))}
          onPick={(ref) => {
            viewState.fillPane(panePickerFor, ref);
            setPanePickerFor(null);
          }}
          onNew={(hostId) => {
            const target = panePickerFor;
            setPanePickerFor(null);
            // Route the new terminal into the pane the picker was opened for,
            // not the focused pane (launch.newTerminalOn's default).
            void app.newSession(hostId).then((sessionId) => {
              if (target && sessionId) viewState.fillPane(target, { hostId, sessionId });
            });
          }}
          onClose={() => setPanePickerFor(null)}
        />
      )}
      {launch.agentChatFor && (
        <div className="agent-folder-backdrop" onPointerDown={() => launch.setAgentChatFor(null)}>
          <div onPointerDown={(e) => e.stopPropagation()}>
            <AgentFolderPicker onPick={launch.startAgentChat} onCancel={() => launch.setAgentChatFor(null)} />
          </div>
        </div>
      )}
      <AppOverflowMenu
        visible={overflowOpen}
        align={overflowAlign}
        onClose={() => setOverflowOpen(false)}
        prefs={prefs}
        onPrefsChange={setPrefs}
        onRename={() => {
          if (!app.activeHost) return;
          modals.openRename(app.activeHost.id, app.activeSessionId, app.activeSessionLabel, app.activeSessionLabel);
        }}
        onAppearance={() => app.setScreen('local-settings')}
        onOpenServerSettings={() => {
          if (!app.activeHostId) return;
          app.setSettingsHostId(app.activeHostId);
          app.setScreen('settings');
        }}
      />
      <AlertModal />
    </div>
  );
}
