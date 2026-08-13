import {
  useServerSettingsHost,
  useTetherAppChrome,
  useTetherAppOverlay,
  useTetherAppSessionPresentations,
  useTetherAppWorkspace,
} from './tether/tetherAppHooks';
import { tetherAppPublic } from './tether/tetherAppPublic';
import { updateProgressLabel } from './tether/transcriptTools';
import { useConnectionConfig } from './tether/useConnectionConfig';

export type { ReviewDiffSlot } from './fetchReviewDiff';
export type { GitLogEntry } from './tether/types';

export function useTetherApp() {
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
  return tetherAppPublic({
    chrome,
    connection,
    sessions,
    presentations,
    workspace,
    overlay,
    serverSettings,
    updaterLabel: updateProgressLabel(chrome.updater.updateProgress),
  });
}
