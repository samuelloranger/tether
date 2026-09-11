import { useEffect, useRef, useState } from 'react';
import { httpOriginFor } from '@/core/types';
import { useViewState } from '@/pane/useViewState';
import { ensureNotificationPermission } from '@/platform/desktopNotifications';
import { useDeepLinks } from '@/platform/useDeepLinks';
import { useLaunchUpdateCheck } from '@/platform/useLaunchUpdateCheck';
import { useWindowTheme } from '@/platform/useWindowTheme';
import { liveSessionKeys } from '@/session/residentKeys';
import { useSessionModals } from '@/session/SessionModals';
import { useSessionLaunch } from '@/session/useSessionLaunch';
import { useTabDrag } from '@/session/useTabDrag';
import { type AppPreferences, loadPreferences } from '@/settings/preferences';
import { AlertModal } from '@/shell/AlertModal';
import { appScreen } from '@/shell/AppScreens';
import { MainScreen } from '@/shell/MainScreen';
import { useAppChrome } from '@/shell/useAppChrome';
import { useTetherDesktop } from '@/shell/useTetherDesktop';
import { setFileOpenListener } from '@/workspace/fileOpenBus';
import { useWorkspace } from '@/workspace/useWorkspace';
import { useGitPanel } from './git/useGitPanel';

export function App() {
  const app = useTetherDesktop();
  const [prefs, setPrefs] = useState<AppPreferences>(loadPreferences);
  // Nothing to diff or browse without a session: `/api/sessions//diff`.
  const hasSession = !!app.activeSessionId;
  const gitPanel = useGitPanel(app.activeHostId, app.activeSessionId, app.gitOpen && hasSession);
  const workspace = useWorkspace({
    hostId: app.activeHostId,
    sessionId: app.activeSessionId,
    baseUrl: app.activeHost ? httpOriginFor(app.activeHost) : null,
    enabled: app.ready && app.screen === 'main' && !!app.activeHost && hasSession,
  });
  const chrome = useAppChrome({ app, workspace, prefs });
  const modals = useSessionModals();

  const viewState = useViewState({
    liveKeysFor: (views) =>
      new Set([...liveSessionKeys(app.sessions, views, app.healthByHost), ...app.pendingAgentKeys()]),
    sessions: app.sessions,
    healthByHost: app.healthByHost,
    onFocusSession: app.selectSession,
  });
  // Pointer-driven drag: Tauri's native drag-drop handler (kept for OS
  // file-drop upload) swallows in-webview HTML5 DnD on Windows/WebView2.
  const tabDrag = useTabDrag(viewState.dropIntoPane);
  const launch = useSessionLaunch({
    app,
    viewState,
    onLaunched: () => {
      if (!chrome.layout.docked) chrome.setDrawerOpen(false);
    },
  });

  const openFileRef = useRef(workspace.openFile);
  openFileRef.current = workspace.openFile;
  useEffect(() => {
    setFileOpenListener((path, line, column) => {
      void openFileRef.current(path, line, column);
    });
    return () => setFileOpenListener(null);
  }, []);
  useEffect(() => {
    void ensureNotificationPermission();
  }, []);
  useWindowTheme(chrome.flavor);
  useLaunchUpdateCheck();
  useDeepLinks({ ready: app.ready, profiles: app.hosts, onSession: viewState.openSession });

  if (!app.ready) {
    return (
      <div className="app-shell" {...chrome.shellProps}>
        <div className="boot-message">
          <span className="boot-mark">tether</span>
          <span className="boot-status">starting</span>
        </div>
      </div>
    );
  }

  const screen = appScreen({ app, prefs, setPrefs });
  if (screen) {
    return (
      <div className="app-shell centered" {...chrome.shellProps}>
        {screen}
        <AlertModal />
      </div>
    );
  }

  return (
    <div className="app-shell" {...chrome.shellProps}>
      <MainScreen
        app={app}
        workspace={workspace}
        gitPanel={gitPanel}
        modals={modals}
        viewState={viewState}
        launch={launch}
        tabDrag={tabDrag}
        prefs={prefs}
        setPrefs={setPrefs}
        chrome={chrome}
        hasSession={hasSession}
      />
    </div>
  );
}
