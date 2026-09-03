import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertModal } from './AlertModal';
import { AppOverflowMenu } from './AppOverflowMenu';
import { ensureNotificationPermission } from './desktopNotifications';
import { FileViewer } from './FileViewer';
import { setFileOpenListener } from './fileOpenBus';
import { GitDrawer } from './git/GitDrawer';
import { GitReview } from './git/GitReview';
import { useGitPanel } from './git/useGitPanel';
import { HostFormScreen } from './HostFormScreen';
import { HostsScreen } from './HostsScreen';
import { activeSessionDot, litStateFor, shellVars } from './litTheme';
import { PresentationBanner, PresentationView } from './PresentationView';
import {
  type AppPreferences,
  loadPaneTree,
  loadPreferences,
  resolveFlavor,
  savePaneTree,
  savePreferences,
  sidebarLayout,
  UI_THEMES,
} from './preferences';
import {
  findLeaf,
  firstLeafId,
  type PaneDir,
  type PaneNode,
  type PaneSide,
  type SessionRef,
  closePane,
  setRatio,
  setSession,
  splitLeaf,
} from './paneTree';
import { PanePickerModal } from './PanePickerModal';
import { prunePaneTree } from './paneTreeSerialize';
import { sessionKey } from './sessionKey';
import { ResidentTerminals } from './ResidentTerminals';
import { ServerSettingsScreen } from './ServerSettingsScreen';
import { SessionDrawer } from './SessionDrawer';
import { SessionModalHost, useSessionModals } from './SessionModals';
import { SessionChrome } from './SessionTabBar';
import { LocalSettingsScreen } from './SettingsScreen';
import { hostSecrets } from './secureConfig';
import { TerminalEmpty } from './TerminalEmpty';
import { httpOriginFor } from './types';
import { useDeepLinks } from './useDeepLinks';
import { useShellChrome } from './useHeatArrival';
import { useLaunchUpdateCheck } from './useLaunchUpdateCheck';
import { useTetherDesktop } from './useTetherDesktop';
import { useWindowTheme } from './useWindowTheme';
import { useWorkspace, WorkspacePanel } from './useWorkspace';

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

  // Split layout: a binary pane tree, persisted. The focused pane's session is
  // the app-wide active session, so git/workspace/tint keep following it.
  const [tree, setTreeState] = useState<PaneNode>(loadPaneTree);
  const [focusedPaneId, setFocusedPaneId] = useState<string>(() => firstLeafId(tree));
  const [panePickerFor, setPanePickerFor] = useState<string | null>(null);
  const updateTree = (next: PaneNode) => {
    setTreeState(next);
    savePaneTree(next);
  };

  // Seed the focused empty pane with the active session (first-run / single pane).
  useEffect(() => {
    if (!app.activeHostId || !app.activeSessionId) return;
    const ref: SessionRef = { hostId: app.activeHostId, sessionId: app.activeSessionId };
    const focused = findLeaf(tree, focusedPaneId);
    if (focused && !focused.session) updateTree(setSession(tree, focusedPaneId, ref));
  }, [app.activeHostId, app.activeSessionId, tree, focusedPaneId]);

  // Drop sessions that no longer exist out of the tree (killed elsewhere).
  useEffect(() => {
    const live = new Set(app.sessions.map((row) => sessionKey(row.hostId, row.id)));
    const pruned = prunePaneTree(tree, live);
    if (pruned !== tree) updateTree(pruned);
  }, [app.sessions]);

  // Focused pane → active session, so the rest of the app follows the focus.
  useEffect(() => {
    const leaf = findLeaf(tree, focusedPaneId);
    if (leaf?.session) app.selectSession(leaf.session.hostId, leaf.session.sessionId);
  }, [focusedPaneId, tree]);

  const splitPane = (paneId: string, dir: PaneDir, side: PaneSide) => {
    updateTree(splitLeaf(tree, paneId, dir, side, null));
  };
  // Split/close shortcuts. Gate on Cmd, or Ctrl+Shift — never plain Ctrl+D,
  // which is the terminal's EOF and must still reach the PTY.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = e.metaKey || (e.ctrlKey && e.shiftKey);
      if (!active) return;
      const k = e.key.toLowerCase();
      if (k === 'd') {
        e.preventDefault();
        splitPane(focusedPaneId, 'row', 'b');
      } else if (k === 'e') {
        e.preventDefault();
        splitPane(focusedPaneId, 'col', 'b');
      } else if (k === 'w') {
        e.preventDefault();
        closePane_(focusedPaneId);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focusedPaneId, tree]);
  const closePane_ = (paneId: string) => {
    const next = closePane(tree, paneId);
    updateTree(next);
    if (!findLeaf(next, focusedPaneId)) setFocusedPaneId(firstLeafId(next));
  };
  const fillPane = (paneId: string, ref: SessionRef) => {
    updateTree(setSession(tree, paneId, ref));
    setFocusedPaneId(paneId);
  };

  const newTerminalOn = (hostId: string | null) => {
    if (!hostId) return;
    void app.newSession(hostId);
    if (!layout.docked) setDrawerOpen(false);
  };

  useEffect(() => {
    void ensureNotificationPermission();
  }, []);

  useWindowTheme(flavor);
  useLaunchUpdateCheck();

  useDeepLinks({
    ready: app.ready,
    profiles: app.hosts,
    onSession: app.selectSession,
  });

  const editingHost = useMemo(
    () => app.hosts.find((host) => host.id === app.editingHostId) ?? null,
    [app.hosts, app.editingHostId],
  );

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

  // A file viewer or presentation owns the whole terminal pane while it is up, so
  // the git overlays stand down rather than stacking over one — opening a file
  // with git open used to look like a no-op. Git returns when the viewer closes.
  const fileOrPreviewUp = Boolean(
    workspace.fileView || workspace.fileLoading || workspace.activePresentation,
  );

  const shellProps = useShellChrome(litState, {
    ...shellVars(theme, litState),
    background: theme.colors.background,
    color: theme.colors.text,
  });

  if (!app.ready) {
    return (
      <div className="app-shell" {...shellProps}>
        <p className="muted boot-message">Loading…</p>
      </div>
    );
  }

  if (app.hosts.length === 0 || app.screen === 'host-form') {
    return (
      <div className="app-shell centered" {...shellProps}>
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
        <AlertModal />
      </div>
    );
  }

  if (app.screen === 'local-settings') {
    return (
      <div className="app-shell centered" {...shellProps}>
        <LocalSettingsScreen
          prefs={prefs}
          onPrefsChange={setPrefs}
          onBack={() => app.setScreen('main')}
        />
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
          onUnauthorized={() => {
            app.setEditingHostId(settingsHost.id);
            app.setScreen('host-form');
          }}
          onIdentitySaved={(identity) => {
            void app.updateHostIdentity(settingsHost.id, identity);
          }}
          onPasswordChanged={async (password) => {
            await app.updateHostPassword(settingsHost.id, password);
          }}
          onConnectionSaved={async (changes, replacementPassword) => {
            await app.updateHostConnection(settingsHost.id, changes, replacementPassword);
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
              app.selectSession(hostId, sessionId);
              if (!layout.docked) setDrawerOpen(false);
            }}
            onNew={newTerminalOn}
            onRequestKill={modals.openKill}
            onRequestRename={modals.openRename}
            onRetryHost={app.retryHost}
            onReenterPassword={(hostId) => {
              app.setEditingHostId(hostId);
              app.setScreen('host-form');
            }}
            onOpenHosts={() => app.setScreen('hosts')}
            onOpenSettings={() => openOverflow('start')}
            onOpenHostSettings={(hostId) => {
              app.setSettingsHostId(hostId);
              app.setScreen('settings');
            }}
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
              dot={activeDot}
              hasSession={hasSession}
              onNew={newTerminalOn}
              onKill={modals.openKill}
              onWorkspace={() => workspace.setWorkspaceOpen(true)}
              onUpload={() => void workspace.pickAndUpload()}
              onOverflow={() => openOverflow('end')}
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
                    onNew={() => newTerminalOn(app.activeHostId)}
                  />
                  <ResidentTerminals
                    hosts={app.hosts}
                    passwords={app.passwords}
                    sessions={app.sessions}
                    tree={tree}
                    focusedPaneId={focusedPaneId}
                    terminalTheme={theme.terminal}
                    fontFamily={prefs.terminalFont}
                    onFrame={app.handleWsFrame}
                    onDisconnected={(hostId) => app.retryHost(hostId)}
                    onFocusPane={setFocusedPaneId}
                    onSetRatio={(branchId, ratio) => updateTree(setRatio(tree, branchId, ratio))}
                    onPickSession={(paneId) => setPanePickerFor(paneId)}
                    onSplit={splitPane}
                    onClosePane={closePane_}
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

      <SessionModalHost
        modals={modals}
        onRename={(hostId, sessionId, name) => void app.renameSessionById(hostId, sessionId, name)}
        onKill={(hostId, sessionId) => void app.killSessionById(hostId, sessionId)}
      />
      {panePickerFor && (
        <PanePickerModal
          hosts={app.hosts}
          sessions={app.sessions}
          onPick={(ref) => {
            fillPane(panePickerFor, ref);
            setPanePickerFor(null);
          }}
          onNew={(hostId) => {
            newTerminalOn(hostId);
            setPanePickerFor(null);
          }}
          onClose={() => setPanePickerFor(null)}
        />
      )}
      <AppOverflowMenu
        visible={overflowOpen}
        align={overflowAlign}
        onClose={() => setOverflowOpen(false)}
        prefs={prefs}
        onPrefsChange={setPrefs}
        onRename={() => {
          if (!app.activeHost) return;
          modals.openRename(
            app.activeHost.id,
            app.activeSessionId,
            app.activeSessionLabel,
            app.activeSessionLabel,
          );
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
