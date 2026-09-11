import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

export const fsRoutes = new Hono();

// Session-less directory listing for the agent-chat folder picker: it needs a
// cwd BEFORE a session exists, so it cannot reuse the per-session workspace
// routes in `files.ts` (those resolve relative to an already-running session's
// root). Lists immediate subdirectories only — files and dotfiles are noise
// for a "pick a folder to start a chat in" screen.
const MAX_DIRS = 200;

fsRoutes.get('/api/fs/dirs', (c) => {
  const requested = c.req.query('path');
  const target = requested && requested.length > 0 ? requested : os.homedir();

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch (error) {
    return c.json(
      { error: `cannot read directory: ${String((error as Error).message ?? error)}` },
      400,
    );
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_DIRS);

  const resolvedParent = path.dirname(target);
  const parent = resolvedParent === target ? null : resolvedParent;

  return c.json({ path: target, parent, dirs });
});
