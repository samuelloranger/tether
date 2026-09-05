// biome-ignore-all lint/style/noExcessiveLinesPerFile: root app shell — routes every screen and wires the drawer, terminal panes, git, and workspace panels
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertModal } from './AlertModal';
import { AppOverflowMenu } from './AppOverflowMenu';
import { DevicesScreen } from './DevicesScreen';
import { ensureNotificationPermission } from './desktopNotifications';
import type { DropIntent } from './dropZone';
import { FileViewer } from './FileViewer';
import { setFileOpenListener } from './fileOpenBus';
import { GitDrawer } from './git/GitDrawer';
import { GitReview } from './git/GitReview';
import { useGitPanel } from './git/useGitPanel';
import { HostsScreen } from './HostsScreen';
import { activeSessionDot, litStateFor, shellVars } from './litTheme';
import { PairDeviceScreen } from './PairDeviceScreen';
import { PanePickerModal } from './PanePickerModal';
import { PresentationBanner, PresentationView } from './PresentationView';
import {
  closePane,
  findLeaf,
  firstLeafId,
  leaves,
  type PaneDir,
  type PaneNode,
  type PaneSide,
  type SessionRef,
  setRatio,
  setSession,
  splitLeaf,
} from './paneTree';
import {
  type AppPreferences,
  loadPreferences,
  loadViews,
  resolveFlavor,
  savePreferences,
  saveViews,
  sidebarLayout,
  UI_THEMES,
} from './preferences';
import { ResidentTerminals } from './ResidentTerminals';
import { ServerSettingsScreen } from './ServerSettingsScreen';
import { SessionDrawer } from './SessionDrawer';
import { SessionModalHost, useSessionModals } from './SessionModals';
import { SessionChrome } from './SessionTabBar';
import { LocalSettingsScreen } from './SettingsScreen';
import { sessionKey } from './sessionKey';
import { TerminalEmpty } from './TerminalEmpty';
import { type DrawerSession, type HostHealthStatus, httpOriginFor } from './types';
import { useDeepLinks } from './useDeepLinks';
import { useShellChrome } from './useHeatArrival';
import { useLaunchUpdateCheck } from './useLaunchUpdateCheck';
import { useTabDrag } from './useTabDrag';
import { useTetherDesktop } from './useTetherDesktop';
import { useWindowTheme } from './useWindowTheme';
import { useWorkspace, WorkspacePanel } from './useWorkspace';
import {
  moveSessionIntoView,
  newSoloView,
  reconcileViews,
  type View,
  type ViewState,
  viewMemberKeys,
} from './viewModel';
import { serializeViews } from './viewsSerialize';

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

function statesEqual(a: ViewState, b: ViewState): boolean {
  return serializeViews(a) === serializeViews(b);
}

function patchActiveView(views: View[], activeViewId: string, patch: (view: View) => View): View[] {
  return views.map((view) => (view.id === activeViewId ? patch(view) : view));
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

  // Per-view layouts: solo (1 leaf) or group (2+). The active view's focused
  // pane is the app-wide active session, so git/workspace/tint keep following it.
  const initialViews = useMemo(() => loadViews(), []);
  const [views, setViews] = useState<View[]>(initialViews.views);
  const [activeViewId, setActiveViewId] = useState(initialViews.activeViewId);
  const [panePickerFor, setPanePickerFor] = useState<string | null>(null);
  const viewStateRef = useRef<ViewState>({ views, activeViewId });
  viewStateRef.current = { views, activeViewId };
  const applyViews = (next: ViewState) => {
    viewStateRef.current = next;
    setViews(next.views);
    setActiveViewId(next.activeViewId);
    saveViews(next);
  };
  const activeView = views.find((view) => view.id === activeViewId) ?? views[0];
  const tree: PaneNode = activeView?.tree ?? { kind: 'leaf', id: 'empty', session: null };
  const focusedPaneId = activeView?.focusedPaneId ?? firstLeafId(tree);
  const liveKeys = () =>
    liveSessionKeys(app.sessions, viewStateRef.current.views, app.healthByHost);

  const openSessionKeys = useMemo(
    () => new Set(views.flatMap((view) => viewMemberKeys(view))),
    [views],
  );

  // Every live session belongs to exactly one view leaf.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the live session list; latest views are read from the ref
  useEffect(() => {
    const current = viewStateRef.current;
    const next = reconcileViews(current.views, liveKeys(), current.activeViewId);
    if (!statesEqual(current, next)) applyViews(next);
  }, [app.sessions, app.healthByHost]);

  // Focused pane → active session, so the rest of the app follows the focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: app.selectSession is stable; this mirrors focus into the active session
  useEffect(() => {
    const leaf = findLeaf(tree, focusedPaneId);
    if (leaf?.session) app.selectSession(leaf.session.hostId, leaf.session.sessionId);
  }, [focusedPaneId, tree]);

  const splitPane = (paneId: string, dir: PaneDir, side: PaneSide) => {
    const current = viewStateRef.current;
    applyViews({
      views: patchActiveView(current.views, current.activeViewId, (view) => ({
        ...view,
        tree: splitLeaf(view.tree, paneId, dir, side, null),
      })),
      activeViewId: current.activeViewId,
    });
  };
  // Split/close shortcuts. Gate on Cmd, or Ctrl+Shift — never plain Ctrl+D,
  // which is the terminal's EOF and must still reach the PTY.
  // biome-ignore lint/correctness/useExhaustiveDependencies: splitPane/closePane_ close over the current view via the listed deps
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
  }, [focusedPaneId, tree, views, activeViewId]);
  const closePane_ = (paneId: string) => {
    const current = viewStateRef.current;
    const nextViews = patchActiveView(current.views, current.activeViewId, (view) => {
      const nextTree = closePane(view.tree, paneId);
      return {
        ...view,
        tree: nextTree,
        focusedPaneId: findLeaf(nextTree, view.focusedPaneId)
          ? view.focusedPaneId
          : firstLeafId(nextTree),
      };
    });
    applyViews(reconcileViews(nextViews, liveKeys(), current.activeViewId));
  };
  const fillPane = (paneId: string, ref: SessionRef) => {
    const current = viewStateRef.current;
    const nextViews = patchActiveView(current.views, current.activeViewId, (view) => ({
      ...view,
      tree: setSession(view.tree, paneId, ref),
      focusedPaneId: paneId,
    }));
    applyViews(reconcileViews(nextViews, liveKeys(), current.activeViewId));
  };
  // Right-click a tab → split the active view's focused pane and move that session in.
  const splitFromTab = (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) => {
    const current = viewStateRef.current;
    applyViews(
      moveSessionIntoView(
        current.views,
        sessionKey(hostId, sessionId),
        current.activeViewId,
        {
          kind: 'split',
          paneId:
            current.views.find((v) => v.id === current.activeViewId)?.focusedPaneId ??
            focusedPaneId,
          dir,
          side,
        },
        liveKeys(),
        current.activeViewId,
      ),
    );
  };
  // Drag a tab onto a pane → split at the drop edge, or replace on a center drop.
  const dropSessionIntoPane = (paneId: string, intent: DropIntent, key: string) => {
    const current = viewStateRef.current;
    const op =
      intent.kind === 'replace'
        ? { kind: 'replace' as const, paneId }
        : { kind: 'split' as const, paneId, dir: intent.dir, side: intent.side };
    applyViews(
      moveSessionIntoView(
        current.views,
        key,
        current.activeViewId,
        op,
        liveKeys(),
        current.activeViewId,
      ),
    );
  };
  // Pointer-driven drag: Tauri's native drag-drop handler (kept for OS
  // file-drop upload) swallows in-webview HTML5 DnD on Windows/WebView2.
  const tabDrag = useTabDrag(dropSessionIntoPane);

  const openView = (viewId: string) => {
    const current = viewStateRef.current;
    if (current.activeViewId === viewId) return;
    applyViews({ views: current.views, activeViewId: viewId });
  };

  // Drawer click: activate the view that holds this session (and focus its pane).
  const openSession = (hostId: string, sessionId: string) => {
    const current = viewStateRef.current;
    const key = sessionKey(hostId, sessionId);
    const existing = current.views.find((view) => viewMemberKeys(view).includes(key));
    if (existing) {
      const pane = leaves(existing.tree).find(
        (l) => l.session && sessionKey(l.session.hostId, l.session.sessionId) === key,
      );
      applyViews({
        views: current.views.map((view) =>
          view.id === existing.id && pane ? { ...view, focusedPaneId: pane.id } : view,
        ),
        activeViewId: existing.id,
      });
      return;
    }
    fillPane(focusedPaneId, { hostId, sessionId });
  };

  const newTerminalOn = (hostId: string | null) => {
    if (!hostId) return;
    void app.newSession(hostId).then((sessionId) => {
      if (!sessionId) return;
      const current = viewStateRef.current;
      const key = sessionKey(hostId, sessionId);
      const existing = current.views.find((view) => viewMemberKeys(view).includes(key));
      if (existing) {
        applyViews({ views: current.views, activeViewId: existing.id });
        return;
      }
      const solo = newSoloView({ hostId, sessionId });
      applyViews({ views: [...current.views, solo], activeViewId: solo.id });
    });
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
            onNew={newTerminalOn}
            onRequestKill={modals.openKill}
            onRequestRename={modals.openRename}
            onRetryHost={app.retryHost}
            onOpenHosts={() => app.setScreen('hosts')}
            onOpenSettings={() => openOverflow('start')}
            onOpenHostSettings={(hostId) => {
              app.setSettingsHostId(hostId);
              app.setScreen('settings');
            }}
            onSplitFromTab={splitFromTab}
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
              views={views}
              activeViewId={activeViewId}
              dot={activeDot}
              hasSession={hasSession}
              onNew={newTerminalOn}
              onKill={modals.openKill}
              onKillMembers={modals.openKillMembers}
              onWorkspace={() => workspace.setWorkspaceOpen(true)}
              onUpload={() => void workspace.pickAndUpload()}
              onOverflow={() => openOverflow('end')}
              onSplitFromTab={splitFromTab}
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
                    onNew={() => newTerminalOn(app.activeHostId)}
                  />
                  <ResidentTerminals
                    hosts={app.hosts}
                    sessions={app.sessions}
                    tree={tree}
                    focusedPaneId={focusedPaneId}
                    terminalTheme={theme.terminal}
                    fontFamily={prefs.terminalFont}
                    onFrame={app.handleWsFrame}
                    onDisconnected={(hostId) => app.retryHost(hostId)}
                    onFocusPane={(paneId) => {
                      const current = viewStateRef.current;
                      applyViews({
                        views: patchActiveView(current.views, current.activeViewId, (view) => ({
                          ...view,
                          focusedPaneId: paneId,
                        })),
                        activeViewId: current.activeViewId,
                      });
                    }}
                    onSetRatio={(branchId, ratio) => {
                      const current = viewStateRef.current;
                      applyViews({
                        views: patchActiveView(current.views, current.activeViewId, (view) => ({
                          ...view,
                          tree: setRatio(view.tree, branchId, ratio),
                        })),
                        activeViewId: current.activeViewId,
                      });
                    }}
                    onPickSession={(paneId) => setPanePickerFor(paneId)}
                    onSplit={splitPane}
                    onClosePane={closePane_}
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

      {tabDrag.drag && (
        <div
          className="tab-drag-ghost"
          style={{ left: tabDrag.drag.x, top: tabDrag.drag.y }}
          aria-hidden
        >
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
          sessions={app.sessions.filter(
            (row) => !openSessionKeys.has(sessionKey(row.hostId, row.id)),
          )}
          onPick={(ref) => {
            fillPane(panePickerFor, ref);
            setPanePickerFor(null);
          }}
          onNew={(hostId) => {
            const target = panePickerFor;
            setPanePickerFor(null);
            // Route the new terminal into the pane the picker was opened for,
            // not the focused pane (newTerminalOn's default).
            void app.newSession(hostId).then((sessionId) => {
              if (target && sessionId) fillPane(target, { hostId, sessionId });
            });
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
