import type { Context } from 'hono';

import { getSession } from '../db';
import { GitRootError, resolveGitRoot } from '../gitRoot';
import { getLiveCwd } from '../liveCwd';
import { refreshLiveCwd } from '../ptyHolder';

/**
 * Where a session is, and the git root containing it.
 *
 * Every git and file route needs the same three steps — find the session, learn
 * its working directory, resolve the repository around it — and each used to
 * inline them, which is how three of them ended up skipping the refresh below.
 *
 * The refresh is the substance: the live cwd otherwise only moves when the
 * shell's prompt emits OSC 7, or when a client attaches. A shell with a custom
 * `PS1` therefore left every answer here pointing at the directory the session
 * started in, however far the user had `cd`-ed. Asking the holder to re-read
 * `/proc` costs a unix-socket round trip and works mid-TUI, where OSC 7 never
 * arrives at all.
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
