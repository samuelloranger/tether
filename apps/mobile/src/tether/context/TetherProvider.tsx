import type { ReactNode } from 'react';
import {
  useServerSettingsHost,
  useTetherAppChrome,
  useTetherAppOverlay,
  useTetherAppSessionPresentations,
  useTetherAppWorkspace,
} from '../tetherAppHooks';
import { updateProgressLabel } from '../transcriptTools';
import { useConnectionConfig } from '../useConnectionConfig';
import {
  ChromeProvider,
  ConnectionProvider,
  FileProvider,
  GitProvider,
  PresentationProvider,
  SessionProvider,
  TranscriptProvider,
  UiProvider,
  UpdaterProvider,
} from './domains';
import type { TetherParts } from './parts';
import {
  buildChrome,
  buildConnection,
  buildGit,
  buildPresentation,
  buildSession,
  buildTranscript,
  buildUpdater,
} from './slices';

// The one place the hook graph is assembled. The order is a real dependency
// chain — chrome before connection, both before sessions, workspace after
// sessions, overlay last because its actions close over everything else — so it
// stays a single linear sequence rather than being spread across providers.
function useTetherParts(): TetherParts {
  const chrome = useTetherAppChrome();
  const connection = useConnectionConfig();
  const serverSettings = useServerSettingsHost(
    connection.profiles,
    connection.clientFor,
    connection.isConfiguring,
    connection.setIsConfiguring,
  );
  const { sessions, presentations, closeFileRef } = useTetherAppSessionPresentations(
    connection,
    chrome,
  );
  const workspace = useTetherAppWorkspace(connection, sessions, chrome, closeFileRef);
  const overlay = useTetherAppOverlay({
    connection,
    chrome,
    sessions,
    presentations,
    workspace,
    serverSettings,
  });
  return {
    chrome,
    connection,
    sessions,
    presentations,
    workspace,
    overlay,
    serverSettings,
    updaterLabel: updateProgressLabel(chrome.updater.updateProgress),
  };
}

export function TetherProvider({ children }: { children: ReactNode }) {
  const parts = useTetherParts();
  return (
    <ChromeProvider value={buildChrome(parts)}>
      <UiProvider value={parts.chrome.ui}>
        <UpdaterProvider value={buildUpdater(parts)}>
          <ConnectionProvider value={buildConnection(parts)}>
            <SessionProvider value={buildSession(parts)}>
              <GitProvider value={buildGit(parts)}>
                <FileProvider value={parts.workspace.file}>
                  <PresentationProvider value={buildPresentation(parts)}>
                    <TranscriptProvider value={buildTranscript(parts)}>
                      {children}
                    </TranscriptProvider>
                  </PresentationProvider>
                </FileProvider>
              </GitProvider>
            </SessionProvider>
          </ConnectionProvider>
        </UpdaterProvider>
      </UiProvider>
    </ChromeProvider>
  );
}
