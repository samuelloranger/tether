import { type Context, Hono } from 'hono';
import { getSession } from '../db';
import { GitDiffError, readDiff, readDiffBlob, readDiffSummary } from '../gitDiff';
import {
  commitStaged,
  discardAll,
  discardPath,
  GitOpsError,
  pushBranch,
  readCommitDiff,
  readLog,
  stageAll,
  stageHunk,
  stagePath,
  undoLastCommit,
  unstageAll,
  unstageHunk,
  unstagePath,
} from '../gitOps';
import { resolveGitRoot } from '../gitRoot';
import { readRepoStatus } from '../gitStatus';
import { getLiveCwd } from '../liveCwd';
import { kickSessionGitWatch } from '../pty';
import { previewMime } from './previewMime';

export const gitRoutes = new Hono();

// Resolves the session's git root or returns the error response to send.
function gitRootFor(c: Context, id: string): { root: string } | { response: Response } {
  const session = getSession(id);
  if (!session) return { response: c.json({ error: 'session not found' }, 404) };
  const cwd = getLiveCwd(id);
  if (!cwd)
    return {
      response: c.json({ error: 'waiting for shell to report its working directory' }, 409),
    };
  return { root: resolveGitRoot(cwd) };
}

function handleGitError(c: Context, error: unknown): Response {
  if (error instanceof GitOpsError || error instanceof GitDiffError) {
    return c.json({ error: error.message }, error.status);
  }
  throw error;
}

gitRoutes.get('/api/sessions/:id/diff/summary', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  const cwd = getLiveCwd(c.req.param('id'));
  if (!cwd) return c.json({ error: 'waiting for shell to report its working directory' }, 409);
  try {
    return c.json(readDiffSummary(resolveGitRoot(cwd)));
  } catch (error) {
    if (error instanceof GitDiffError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

gitRoutes.get('/api/sessions/:id/diff', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  const cwd = getLiveCwd(c.req.param('id'));
  if (!cwd) return c.json({ error: 'waiting for shell to report its working directory' }, 409);
  try {
    const modeParam = c.req.query('mode');
    const mode = modeParam === 'staged' || modeParam === 'unstaged' ? modeParam : 'head';
    return c.json(await readDiff(resolveGitRoot(cwd), c.req.query('path'), mode));
  } catch (error) {
    if (error instanceof GitDiffError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// Raw bytes for one side of a binary (typically image) file diff — 'old' is
// the committed blob, 'new' is the working tree copy. Either side can be
// legitimately absent (added/deleted file), reported as 404.
gitRoutes.get('/api/sessions/:id/diff/file', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'session not found' }, 404);
  const cwd = getLiveCwd(c.req.param('id'));
  if (!cwd) return c.json({ error: 'waiting for shell to report its working directory' }, 409);
  const requestedPath = c.req.query('path');
  const side = c.req.query('side');
  if (!requestedPath || (side !== 'old' && side !== 'new')) {
    return c.json({ error: 'invalid path or side' }, 400);
  }
  try {
    const bytes = readDiffBlob(resolveGitRoot(cwd), side, requestedPath);
    if (!bytes) return c.json({ error: 'not found' }, 404);
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': previewMime(requestedPath), 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof GitDiffError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// Git write ops (stage/unstage/discard/commit) and history. Same trust anchor
// as the diff read routes: the session's live cwd resolved to its git root —
// a tree the authenticated shell user already controls.

gitRoutes.post('/api/sessions/:id/git/push', async (c) => {
  try {
    const id = c.req.param('id');
    const resolved = gitRootFor(c, id);
    if ('response' in resolved) return resolved.response;
    pushBranch(resolved.root);
    kickSessionGitWatch(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.post('/api/sessions/:id/git/stage-all', async (c) => {
  try {
    const id = c.req.param('id');
    const resolved = gitRootFor(c, id);
    if ('response' in resolved) return resolved.response;
    stageAll(resolved.root);
    kickSessionGitWatch(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.post('/api/sessions/:id/git/unstage-all', async (c) => {
  try {
    const id = c.req.param('id');
    const resolved = gitRootFor(c, id);
    if ('response' in resolved) return resolved.response;
    unstageAll(resolved.root);
    kickSessionGitWatch(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.post('/api/sessions/:id/git/discard-all', async (c) => {
  try {
    const id = c.req.param('id');
    const resolved = gitRootFor(c, id);
    if ('response' in resolved) return resolved.response;
    discardAll(resolved.root);
    kickSessionGitWatch(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.post('/api/sessions/:id/git/:op{stage-hunk|unstage-hunk}', async (c) => {
  const reverse = c.req.param('op') === 'unstage-hunk';
  try {
    const id = c.req.param('id');
    const resolved = gitRootFor(c, id);
    if ('response' in resolved) return resolved.response;
    const body = (await c.req.json().catch(() => ({}))) as { path?: string; hunkIndex?: number };
    if (typeof body.path !== 'string' || !body.path || typeof body.hunkIndex !== 'number') {
      return c.json({ error: 'path and hunkIndex required' }, 400);
    }
    (reverse ? unstageHunk : stageHunk)(resolved.root, body.path, body.hunkIndex);
    kickSessionGitWatch(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.post('/api/sessions/:id/git/:op{stage|unstage|discard}', async (c) => {
  const op = c.req.param('op') as 'stage' | 'unstage' | 'discard';
  try {
    const id = c.req.param('id');
    const resolved = gitRootFor(c, id);
    if ('response' in resolved) return resolved.response;
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    if (typeof body.path !== 'string' || !body.path) {
      return c.json({ error: 'path required' }, 400);
    }
    const fn = op === 'stage' ? stagePath : op === 'unstage' ? unstagePath : discardPath;
    fn(resolved.root, body.path);
    kickSessionGitWatch(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.post('/api/sessions/:id/git/commit', async (c) => {
  try {
    const id = c.req.param('id');
    const resolved = gitRootFor(c, id);
    if ('response' in resolved) return resolved.response;
    const body = (await c.req.json().catch(() => ({}))) as { message?: string; amend?: boolean };
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'message required' }, 400);
    }
    commitStaged(resolved.root, body.message, body.amend === true);
    kickSessionGitWatch(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.post('/api/sessions/:id/git/undo-commit', async (c) => {
  try {
    const id = c.req.param('id');
    const resolved = gitRootFor(c, id);
    if ('response' in resolved) return resolved.response;
    undoLastCommit(resolved.root);
    kickSessionGitWatch(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.get('/api/sessions/:id/git/status', (c) => {
  try {
    const resolved = gitRootFor(c, c.req.param('id'));
    if ('response' in resolved) return resolved.response;
    return c.json(readRepoStatus(resolved.root));
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.get('/api/sessions/:id/git/log', (c) => {
  try {
    const resolved = gitRootFor(c, c.req.param('id'));
    if ('response' in resolved) return resolved.response;
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json(readLog(resolved.root, Number.isFinite(limit) ? limit : 50));
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.get('/api/sessions/:id/git/commit/:sha/diff', async (c) => {
  try {
    const resolved = gitRootFor(c, c.req.param('id'));
    if ('response' in resolved) return resolved.response;
    return c.json(await readCommitDiff(resolved.root, c.req.param('sha'), c.req.query('path')));
  } catch (error) {
    return handleGitError(c, error);
  }
});
