import type {
  useServerSettingsHost,
  useTetherAppChrome,
  useTetherAppOverlay,
  useTetherAppWorkspace,
} from '../tetherAppHooks';
import type { useConnectionConfig } from '../useConnectionConfig';
import type { usePresentations } from '../usePresentations';
import type { useTerminalSessions } from '../useTerminalSessions';

// The raw hook results, assembled once by the composition root. Nothing outside
// context/ should ever see this shape — components read domains, not parts.
export type TetherParts = {
  chrome: ReturnType<typeof useTetherAppChrome>;
  connection: ReturnType<typeof useConnectionConfig>;
  sessions: ReturnType<typeof useTerminalSessions>;
  presentations: ReturnType<typeof usePresentations>;
  workspace: ReturnType<typeof useTetherAppWorkspace>;
  overlay: ReturnType<typeof useTetherAppOverlay>;
  serverSettings: ReturnType<typeof useServerSettingsHost>;
  updaterLabel: { upPct: number; upLabel: string };
};
