import { confirmAction, notify } from '../dialog';
import { isImagePath } from '../diffModel';
import { fetchDiffImageUri, fetchOneReviewDiff, type ReviewDiffSlot } from '../fetchReviewDiff';
import { mapWithConcurrency, reviewDiffKey, reviewFileEntries } from '../gitReviewModel';
import type { SessionEntry } from '../sessionCache';
import type { HostClient } from './hostClient';
import type { GitLogEntry } from './types';

export type DiffMode = 'staged' | 'unstaged' | null;

export async function gitFetch(
  client: HostClient,
  sessionId: string,
  route: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await client.get(`/api/sessions/${sessionId}/git/${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${res.status})`);
  }
  return body;
}

export function gitPost(
  client: HostClient,
  sessionId: string,
  route: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  return gitFetch(client, sessionId, route, { method: 'POST', body: JSON.stringify(payload) });
}

export async function loadSelectedDiff(opts: {
  client: HostClient;
  sessionId: string;
  filePath: string;
  mode?: 'staged' | 'unstaged';
  entry: SessionEntry;
}): Promise<
  | { kind: 'image'; old: string | null; new: string | null }
  | { kind: 'text'; diff: string; truncated: boolean }
> {
  const file = opts.entry.diffSummary.files.find((f) => f.path === opts.filePath);
  if (file?.binary && isImagePath(opts.filePath)) {
    const query = new URLSearchParams({ path: opts.filePath });
    const [oldUri, newUri] = await Promise.all([
      fetchDiffImageUri(opts.client, `/api/sessions/${opts.sessionId}/diff/file?${query}&side=old`),
      fetchDiffImageUri(opts.client, `/api/sessions/${opts.sessionId}/diff/file?${query}&side=new`),
    ]);
    return { kind: 'image', old: oldUri, new: newUri };
  }
  const query = new URLSearchParams({ path: opts.filePath });
  if (opts.mode) query.set('mode', opts.mode);
  const res = await opts.client.get(`/api/sessions/${opts.sessionId}/diff?${query}`);
  const body = (await res.json().catch(() => ({}))) as {
    diff?: string;
    truncated?: boolean;
    error?: string;
  };
  if (!res.ok || typeof body.diff !== 'string') {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return { kind: 'text', diff: body.diff, truncated: body.truncated === true };
}

export function beginReviewDiffLoad(entry: SessionEntry): Record<string, ReviewDiffSlot> {
  const next: Record<string, ReviewDiffSlot> = {};
  for (const e of reviewFileEntries(entry.diffSummary))
    next[reviewDiffKey(e.mode, e.path)] = { status: 'loading' };
  return next;
}

export async function fillReviewDiffs(opts: {
  client: HostClient;
  sessionId: string;
  entry: SessionEntry;
  gen: number;
  currentGen: () => number;
  setSlot: (key: string, slot: ReviewDiffSlot) => void;
}): Promise<void> {
  const entries = reviewFileEntries(opts.entry.diffSummary);
  await mapWithConcurrency(entries, 5, async (e) => {
    const key = reviewDiffKey(e.mode, e.path);
    const slot = await fetchOneReviewDiff({
      client: opts.client,
      sessionId: opts.sessionId,
      path: e.path,
      mode: e.mode,
      file: e.file,
    });
    if (opts.currentGen() !== opts.gen) return slot;
    opts.setSlot(key, slot);
    return slot;
  });
}

export async function retryOneReviewDiff(opts: {
  client: HostClient;
  sessionId: string;
  entry: SessionEntry;
  mode: 'staged' | 'unstaged';
  path: string;
}): Promise<ReviewDiffSlot | null> {
  const file = opts.entry.diffSummary.files.find((f) => f.path === opts.path);
  if (!file) return null;
  return fetchOneReviewDiff({
    client: opts.client,
    sessionId: opts.sessionId,
    path: opts.path,
    mode: opts.mode,
    file: { ...file, staged: opts.mode === 'staged' },
  });
}

export async function confirmDiscardFile(path: string): Promise<boolean> {
  return confirmAction(
    `Discard changes to ${path}?`,
    "Uncommitted changes to this file will be lost. This can't be undone.",
    { confirmLabel: 'Discard', destructive: true },
  );
}

export async function confirmDiscardAll(): Promise<boolean> {
  return confirmAction(
    'Discard all unstaged changes?',
    "Every unstaged file will be restored or deleted. This can't be undone.",
    { confirmLabel: 'Discard all', destructive: true },
  );
}

export async function confirmUndoCommit(): Promise<boolean> {
  return confirmAction(
    'Undo last commit?',
    'HEAD will move back one commit. Changes stay staged.',
    {
      confirmLabel: 'Undo commit',
    },
  );
}

export async function notifyGitOp(label: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    void notify(label, String(error), 'error');
    return false;
  }
}

export async function loadCommitDiff(
  client: HostClient,
  sessionId: string,
  entry: GitLogEntry,
): Promise<{ entry: GitLogEntry; diff: string | null; truncated: boolean }> {
  const body = (await gitFetch(client, sessionId, `commit/${entry.sha}/diff`)) as {
    diff?: string;
    truncated?: boolean;
  };
  return {
    entry,
    diff: typeof body.diff === 'string' ? body.diff : '',
    truncated: body.truncated === true,
  };
}
