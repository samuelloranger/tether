import { type Context, Hono } from 'hono';
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
import { GitRootError } from '../gitRoot';
import { readRepoStatus } from '../gitStatus';
import { kickSessionGitWatch } from '../pty';
import { previewMime } from './previewMime';
import { resolveSessionCwd } from './sessionCwd';

export const gitRoutes = new Hono();

// Resolves the session's git root or returns the error response to send.
const gitRootFor = resolveSessionCwd;

function handleGitError(c: Context, error: unknown): Response {
  if (error instanceof GitRootError) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof GitOpsError || error instanceof GitDiffError) {
    return c.json({ error: error.message }, error.status);
  }
  throw error;
}

gitRoutes.get('/api/sessions/:id/diff/summary', async (c) => {
  const resolved = await gitRootFor(c, c.req.param('id'));
  if ('response' in resolved) return resolved.response;
  try {
    return c.json(readDiffSummary(resolved.root));
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.get('/api/sessions/:id/diff', async (c) => {
  const resolved = await gitRootFor(c, c.req.param('id'));
  if ('response' in resolved) return resolved.response;
  try {
    const modeParam = c.req.query('mode');
    const mode = modeParam === 'staged' || modeParam === 'unstaged' ? modeParam : 'head';
    return c.json(await readDiff(resolved.root, c.req.query('path'), mode));
  } catch (error) {
    return handleGitError(c, error);
  }
});

// Raw bytes for one side of a binary (typically image) file diff — 'old' is
// the committed blob, 'new' is the working tree copy. Either side can be
// legitimately absent (added/deleted file), reported as 404.
gitRoutes.get('/api/sessions/:id/diff/file', async (c) => {
  const requestedPath = c.req.query('path');
  const side = c.req.query('side');
  if (!requestedPath || (side !== 'old' && side !== 'new')) {
    return c.json({ error: 'invalid path or side' }, 400);
  }
  const resolved = await gitRootFor(c, c.req.param('id'));
  if ('response' in resolved) return resolved.response;
  try {
    const bytes = readDiffBlob(resolved.root, side, requestedPath);
    if (!bytes) return c.json({ error: 'not found' }, 404);
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': previewMime(requestedPath), 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return handleGitError(c, error);
  }
});

// Git write ops (stage/unstage/discard/commit) and history. Same trust anchor
// as the diff read routes: the session's live cwd resolved to its git root —
// a tree the authenticated shell user already controls.

gitRoutes.post('/api/sessions/:id/git/push', async (c) => {
  try {
    const id = c.req.param('id');
    const resolved = await gitRootFor(c, id);
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
    const resolved = await gitRootFor(c, id);
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
    const resolved = await gitRootFor(c, id);
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
    const resolved = await gitRootFor(c, id);
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
    const resolved = await gitRootFor(c, id);
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
    const resolved = await gitRootFor(c, id);
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
    const resolved = await gitRootFor(c, id);
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
    const resolved = await gitRootFor(c, id);
    if ('response' in resolved) return resolved.response;
    undoLastCommit(resolved.root);
    kickSessionGitWatch(id);
    return c.json({ ok: true });
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.get('/api/sessions/:id/git/status', async (c) => {
  try {
    const resolved = await gitRootFor(c, c.req.param('id'));
    if ('response' in resolved) return resolved.response;
    return c.json(readRepoStatus(resolved.root));
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.get('/api/sessions/:id/git/log', async (c) => {
  try {
    const resolved = await gitRootFor(c, c.req.param('id'));
    if ('response' in resolved) return resolved.response;
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json(readLog(resolved.root, Number.isFinite(limit) ? limit : 50));
  } catch (error) {
    return handleGitError(c, error);
  }
});

gitRoutes.get('/api/sessions/:id/git/commit/:sha/diff', async (c) => {
  try {
    const resolved = await gitRootFor(c, c.req.param('id'));
    if ('response' in resolved) return resolved.response;
    return c.json(await readCommitDiff(resolved.root, c.req.param('sha'), c.req.query('path')));
  } catch (error) {
    return handleGitError(c, error);
  }
});
