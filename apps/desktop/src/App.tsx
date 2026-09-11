// biome-ignore-all lint/style/noExcessiveLinesPerFile: root app shell — routes every screen and wires the drawer, terminal panes, git, and workspace panels
import { useEffect, useMemo, useRef, useState } from 'react';
import { type DrawerSession, type HostHealthStatus, httpOriginFor } from '@/core/types';
import { DevicesScreen } from '@/host/DevicesScreen';
import { HostsScreen } from '@/host/HostsScreen';
import { PairDeviceScreen } from '@/host/PairDeviceScreen';
import type { DropIntent } from '@/pane/dropZone';
import { PanePickerModal } from '@/pane/PanePickerModal';
import {
  findLeaf,
  firstLeafId,
  leaves,
  type PaneDir,
  type PaneNode,
  type PaneSide,
  type SessionRef,
} from '@/pane/paneTree';
import { newSoloView, type View, type ViewState, viewMemberKeys } from '@/pane/viewModel';
import {
  addSoloViewOp,
  closePaneOp,
  dropIntoPaneOp,
  fillPaneOp,
  focusPaneOp,
  openSessionOp,
  openViewOp,
  reconcileOp,
  setRatioOp,
  splitFromTabOp,
  splitPaneOp,
  statesEqual,
} from '@/pane/viewOps';
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
import { touchLru } from '@/session/sessionLru';
import { useTabDrag } from '@/session/useTabDrag';
import {
  type AppPreferences,
  loadPreferences,
  loadViews,
  resolveFlavor,
  savePreferences,
  saveViews,
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

  // Per-view layouts: solo (1 leaf) or group (2+). The active view's focused
  // pane is the app-wide active session, so git/workspace/tint keep following it.
  const initialViews = useMemo(() => loadViews(), []);
  const [views, setViews] = useState<View[]>(initialViews.views);
  const [activeViewId, setActiveViewId] = useState(initialViews.activeViewId);
  const [panePickerFor, setPanePickerFor] = useState<string | null>(null);
  const [agentChatFor, setAgentChatFor] = useState<string | null>(null);
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
  // Recency order of active sessions — feeds residentSessions so recently-used
  // background tabs keep a live socket (zero replay on switch-back).
  const [lruOrder, setLruOrder] = useState<string[]>([]);
  const liveKeys = () =>
    new Set([
      ...liveSessionKeys(app.sessions, viewStateRef.current.views, app.healthByHost),
      ...app.pendingAgentKeys(),
    ]);

  const openSessionKeys = useMemo(() => new Set(views.flatMap((view) => viewMemberKeys(view))), [views]);

  // Every live session belongs to exactly one view leaf.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the live session list; latest views are read from the ref
  useEffect(() => {
    const current = viewStateRef.current;
    const next = reconcileOp(current, liveKeys());
    if (!statesEqual(current, next)) applyViews(next);
  }, [app.sessions, app.healthByHost]);

  // Focused pane → active session, so the rest of the app follows the focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: app.selectSession is stable; this mirrors focus into the active session
  useEffect(() => {
    const leaf = findLeaf(tree, focusedPaneId);
    if (leaf?.session) {
      app.selectSession(leaf.session.hostId, leaf.session.sessionId);
      const key = sessionKey(leaf.session.hostId, leaf.session.sessionId);
      setLruOrder((order) => touchLru(order, key));
    }
  }, [focusedPaneId, tree]);

  const splitPane = (paneId: string, dir: PaneDir, side: PaneSide) => {
    applyViews(splitPaneOp(viewStateRef.current, paneId, dir, side));
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
    applyViews(closePaneOp(viewStateRef.current, paneId, liveKeys()));
  };
  const fillPane = (paneId: string, ref: SessionRef) => {
    applyViews(fillPaneOp(viewStateRef.current, paneId, ref, liveKeys()));
  };
  // Right-click a tab → split the active view's focused pane and move that session in.
  const splitFromTab = (hostId: string, sessionId: string, dir: PaneDir, side: PaneSide) => {
    applyViews(
      splitFromTabOp(viewStateRef.current, sessionKey(hostId, sessionId), dir, side, focusedPaneId, liveKeys()),
    );
  };
  // Drag a tab onto a pane → split at the drop edge, or replace on a center drop.
  const dropSessionIntoPane = (paneId: string, intent: DropIntent, key: string) => {
    applyViews(dropIntoPaneOp(viewStateRef.current, paneId, intent, key, liveKeys()));
  };
  // Pointer-driven drag: Tauri's native drag-drop handler (kept for OS
  // file-drop upload) swallows in-webview HTML5 DnD on Windows/WebView2.
  const tabDrag = useTabDrag(dropSessionIntoPane);

  const openView = (viewId: string) => {
    applyViews(openViewOp(viewStateRef.current, viewId));
  };

  // Drawer click: activate the view that holds this session (and focus its pane).
  const openSession = (hostId: string, sessionId: string) => {
    applyViews(openSessionOp(viewStateRef.current, hostId, sessionId, focusedPaneId, liveKeys()));
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
      applyViews(addSoloViewOp(current, newSoloView({ hostId, sessionId })));
    });
    if (!layout.docked) setDrawerOpen(false);
  };

  const newAgentChatOn = (hostId: string | null) => {
    if (hostId) setAgentChatFor(hostId);
  };

  const startAgentChat = (cwd: string) => {
    const hostId = agentChatFor;
    setAgentChatFor(null);
    if (!hostId) return;
    void app.newAgentChat(hostId).then((sessionId) => {
      if (!sessionId) return;
      const current = viewStateRef.current;
      applyViews(addSoloViewOp(current, newSoloView({ hostId, sessionId, kind: 'agent', cwd })));
    });
    if (!layout.docked) setDrawerOpen(false);
  };

  // /resume: open the picked past Claude session in a fresh agent tab.
  const resumeAgentChat = (hostId: string, cwd: string | undefined, claudeSessionId: string) => {
    void app.newAgentChat(hostId).then((sessionId) => {
      if (!sessionId) return;
      const current = viewStateRef.current;
      applyViews(
        addSoloViewOp(
          current,
          newSoloView({ hostId, sessionId, kind: 'agent', cwd, resumeSessionId: claudeSessionId }),
        ),
      );
    });
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
            onNew={newTerminalOn}
            onNewAgentChat={newAgentChatOn}
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
              onNewAgentChat={newAgentChatOn}
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
                    lruOrder={lruOrder}
                    terminalTheme={theme.terminal}
                    fontFamily={prefs.terminalFont}
                    onFrame={app.handleWsFrame}
                    onDisconnected={(hostId) => app.retryHost(hostId)}
                    onResumeSession={resumeAgentChat}
                    onFocusPane={(paneId) => applyViews(focusPaneOp(viewStateRef.current, paneId))}
                    onSetRatio={(branchId, ratio) => applyViews(setRatioOp(viewStateRef.current, branchId, ratio))}
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
          sessions={app.sessions.filter((row) => !openSessionKeys.has(sessionKey(row.hostId, row.id)))}
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
      {agentChatFor && (
        <div className="agent-folder-backdrop" onPointerDown={() => setAgentChatFor(null)}>
          <div onPointerDown={(e) => e.stopPropagation()}>
            <AgentFolderPicker onPick={startAgentChat} onCancel={() => setAgentChatFor(null)} />
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
