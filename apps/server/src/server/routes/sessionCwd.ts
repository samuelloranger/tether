import type { Context } from 'hono';

import { getSession } from '../db';
import { GitRootError, resolveGitRoot } from '../gitRoot';
import { getLiveCwd } from '../liveCwd';
import { refreshLiveCwd } from '../ptyHolder';

/**
 * Session cwd + its git root. The refresh matters: live cwd otherwise only moves
 * on OSC 7 / client attach, so a custom PS1 leaves it stale; /proc works mid-TUI.
 */
export async function resolveSessionCwd(
  c: Context,
  id: string,
): Promise<{ cwd: string; root: string } | { response: Response }> {
  const session = getSession(id);
  if (!session) return { response: c.json({ error: 'session not found' }, 404) };
  await refreshLiveCwd(id);
  const cwd = getLiveCwd(id);
  if (!cwd)
    return {
      response: c.json({ error: 'waiting for shell to report its working directory' }, 409),
    };
  try {
    return { cwd, root: resolveGitRoot(cwd) };
  } catch (error) {
    if (error instanceof GitRootError) {
      return { response: c.json({ error: error.message }, error.status) };
    }
    throw error;
  }
}
