import { AgentFolderPicker } from '@/agent/AgentFolderPicker';
import { GitDrawer } from '@/git/GitDrawer';
import { GitReview } from '@/git/GitReview';
import type { GitPanelState } from '@/git/useGitPanel';
import { PanePickerModal } from '@/pane/PanePickerModal';
import type { ViewStateApi } from '@/pane/useViewState';
import { PresentationBanner, PresentationView } from '@/presentations/PresentationView';
import { ResidentTerminals } from '@/session/ResidentTerminals';
import { SessionDrawer } from '@/session/SessionDrawer';
import { SessionModalHost, type SessionModals } from '@/session/SessionModals';
import { SessionChrome } from '@/session/SessionTabBar';
import { sessionKey } from '@/session/sessionKey';
import type { SessionLaunch } from '@/session/useSessionLaunch';
import type { useTabDrag } from '@/session/useTabDrag';
import { type AppPreferences, savePreferences } from '@/settings/preferences';
import { AlertModal } from '@/shell/AlertModal';
import { AppOverflowMenu } from '@/shell/AppOverflowMenu';
import type { AppChrome } from '@/shell/useAppChrome';
import type { TetherDesktop } from '@/shell/useTetherDesktop';
import { TerminalEmpty } from '@/terminal/TerminalEmpty';
import { FileViewer } from '@/workspace/FileViewer';
import { WorkspacePanel, type WorkspaceState } from '@/workspace/useWorkspace';

export interface MainScreenProps {
  app: TetherDesktop;
  workspace: WorkspaceState;
  gitPanel: GitPanelState;
  modals: SessionModals;
  viewState: ViewStateApi;
  launch: SessionLaunch;
  tabDrag: ReturnType<typeof useTabDrag>;
  prefs: AppPreferences;
  setPrefs: (prefs: AppPreferences) => void;
  chrome: AppChrome;
  hasSession: boolean;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one screen's render tree — the drawer, terminal panes, git overlays and modal hosts
export function MainScreen({
  app,
  workspace,
  gitPanel,
  modals,
  viewState,
  launch,
  tabDrag,
  prefs,
  setPrefs,
  chrome,
  hasSession,
}: MainScreenProps) {
  // A local const, not chrome.panePickerFor: TS keeps the null-narrowing across
  // the callbacks below only for a local binding.
  const panePickerFor = chrome.panePickerFor;
  return (
    <>
      {chrome.layout.showMenuButton ? (
        <button
          type="button"
          className="drawer-menu-button"
          aria-label="Open sessions"
          onClick={() => chrome.setDrawerOpen(true)}
        >
          ☰
        </button>
      ) : null}
      {chrome.layout.visible ? (
        <>
          {!chrome.layout.docked ? (
            <button
              type="button"
              className="drawer-scrim"
              aria-label="Close sessions"
              onClick={() => chrome.setDrawerOpen(false)}
            />
          ) : null}
          <SessionDrawer
            hosts={app.hosts}
            healthByHost={app.healthByHost}
            sessions={app.sessions}
            activeHostId={app.activeHostId}
            activeSessionId={app.activeSessionId}
            docked={chrome.layout.docked}
            showPin={chrome.wide}
            sidebarPinned={prefs.sidebarPinned}
            onTogglePin={() => {
              const next = { ...prefs, sidebarPinned: !prefs.sidebarPinned };
              savePreferences(next);
              setPrefs(next);
              if (prefs.sidebarPinned) chrome.setDrawerOpen(false);
            }}
            onSelect={(hostId, sessionId) => {
              viewState.openSession(hostId, sessionId);
              if (!chrome.layout.docked) chrome.setDrawerOpen(false);
            }}
            onNew={launch.newTerminalOn}
            onNewAgentChat={launch.newAgentChatOn}
            onRequestKill={modals.openKill}
            onRequestRename={modals.openRename}
            onRetryHost={app.retryHost}
            onOpenHosts={() => app.setScreen('hosts')}
            onOpenSettings={() => chrome.openOverflow('start')}
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
              showTabBar={chrome.layout.showTabBar}
              inset={chrome.layout.showMenuButton}
              app={app}
              views={viewState.views}
              activeViewId={viewState.activeViewId}
              dot={chrome.activeDot}
              hasSession={hasSession}
              onNew={launch.newTerminalOn}
              onNewAgentChat={launch.newAgentChatOn}
              onKill={modals.openKill}
              onKillMembers={modals.openKillMembers}
              onWorkspace={() => workspace.setWorkspaceOpen(true)}
              onUpload={() => void workspace.pickAndUpload()}
              onOverflow={() => chrome.openOverflow('end')}
              onSplitFromTab={viewState.splitFromTab}
              onSelectView={viewState.openView}
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
                    tree={viewState.tree}
                    focusedPaneId={viewState.focusedPaneId}
                    lruOrder={viewState.lruOrder}
                    terminalTheme={chrome.theme.terminal}
                    fontFamily={prefs.terminalFont}
                    onFrame={app.handleWsFrame}
                    onDisconnected={(hostId) => app.retryHost(hostId)}
                    onResumeSession={launch.resumeAgentChat}
                    onFocusPane={viewState.focusPane}
                    onSetRatio={viewState.setPaneRatio}
                    onPickSession={(paneId) => chrome.setPanePickerFor(paneId)}
                    onSplit={viewState.splitPane}
                    onClosePane={viewState.closePane}
                    preview={tabDrag.drag?.target ?? null}
                  />
                </div>
                {app.gitOpen && !chrome.fileOrPreviewUp && app.gitMode === 'drawer' ? (
                  <GitDrawer panel={gitPanel} onClose={() => app.setGitOpen(false)} />
                ) : null}
                {app.gitOpen && !chrome.fileOrPreviewUp && app.gitMode === 'review' && app.activeHostId ? (
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
                    theme={chrome.theme}
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
            chrome.setPanePickerFor(null);
          }}
          onNew={(hostId) => {
            const target = panePickerFor;
            chrome.setPanePickerFor(null);
            // Route the new terminal into the pane the picker was opened for,
            // not the focused pane (launch.newTerminalOn's default).
            void app.newSession(hostId).then((sessionId) => {
              if (target && sessionId) viewState.fillPane(target, { hostId, sessionId });
            });
          }}
          onClose={() => chrome.setPanePickerFor(null)}
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
        visible={chrome.overflowOpen}
        align={chrome.overflowAlign}
        onClose={() => chrome.setOverflowOpen(false)}
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
    </>
  );
}
