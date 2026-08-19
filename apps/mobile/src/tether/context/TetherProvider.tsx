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
import { useStableDomain } from './useStableDomain';

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
  // Stabilize each domain independently so a change in one does not invalidate
  // the other eight. Every hook still runs on every root render; only the
  // context values held steady.
  const chrome = useStableDomain(buildChrome(parts));
  const ui = useStableDomain(parts.chrome.ui);
  const updater = useStableDomain(buildUpdater(parts));
  const connection = useStableDomain(buildConnection(parts));
  const session = useStableDomain(buildSession(parts));
  const git = useStableDomain(buildGit(parts));
  const file = useStableDomain(parts.workspace.file);
  const presentation = useStableDomain(buildPresentation(parts));
  const transcript = useStableDomain(buildTranscript(parts));
  return (
    <ChromeProvider value={chrome}>
      <UiProvider value={ui}>
        <UpdaterProvider value={updater}>
          <ConnectionProvider value={connection}>
            <SessionProvider value={session}>
              <GitProvider value={git}>
                <FileProvider value={file}>
                  <PresentationProvider value={presentation}>
                    <TranscriptProvider value={transcript}>{children}</TranscriptProvider>
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
