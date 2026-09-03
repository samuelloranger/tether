import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { UPLOADS_DIR } from '../paths';
import { resolveUploadPath } from '../upload';
import { readWorkspaceDir } from '../workspaceDir';
import { readWorkspaceFile, WorkspaceFileError } from '../workspaceFile';
import { resolveSessionCwd } from './sessionCwd';

export const filesRoutes = new Hono();

filesRoutes.get('/api/sessions/:id/file', async (c) => {
  const resolved = await resolveSessionCwd(c, c.req.param('id'));
  if ('response' in resolved) return resolved.response;
  try {
    return c.json(readWorkspaceFile(resolved.root, c.req.query('path') ?? '', resolved.cwd));
  } catch (error) {
    if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

filesRoutes.get('/api/sessions/:id/dir', async (c) => {
  const resolved = await resolveSessionCwd(c, c.req.param('id'));
  if ('response' in resolved) return resolved.response;
  try {
    return c.json(readWorkspaceDir(resolved.root, c.req.query('path') ?? '', resolved.cwd));
  } catch (error) {
    if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// Receive an uploaded file (mobile image-picker, iOS/iPadOS drag-drop, desktop
// drag-drop all funnel through here) and write it into a per-session upload
// dir under ~/.tether/uploads, not the session's live cwd — keeps uploads out
// of whatever project the user happens to be working in.
filesRoutes.post('/api/sessions/:id/upload', async (c) => {
  const sessionId = c.req.param('id');
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ ok: false, error: 'invalid form data' }, 400);
  const file = form.get('file');
  const filenameOverride = form.get('filename');
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: 'missing file' }, 400);
  }
  const filename =
    typeof filenameOverride === 'string' && filenameOverride ? filenameOverride : file.name;
  const dir = path.join(UPLOADS_DIR, sessionId);
  let dest: string;
  try {
    mkdirSync(dir, { recursive: true });
    dest = resolveUploadPath(dir, filename);
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 400);
  }
  await Bun.write(dest, file);
  return c.json({ ok: true, path: dest });
});
