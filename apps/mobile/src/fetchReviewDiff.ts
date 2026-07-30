import type { DiffFileStat } from './diffModel';
import { isImagePath } from './diffModel';
import type { HostClient } from './tether/hostClient';

export type ReviewDiffSlot =
  | { status: 'loading' }
  | { status: 'ready'; text: string; truncated: boolean }
  | { status: 'image'; old: string | null; new: string | null }
  | { status: 'error'; message: string };

// Fetches raw image bytes with the auth header <Image> can't attach itself,
// and hands back a data URI so the same code path works native and web.
export async function fetchDiffImageUri(client: HostClient, path: string): Promise<string | null> {
  const res = await client.get(path);
  if (!res.ok) return null;
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('failed to read image'));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

export function reviewDiffRequestPath(
  sessionId: string,
  filePath: string,
  mode: 'staged' | 'unstaged',
  kind: 'text' | 'image-old' | 'image-new',
): string {
  const query = new URLSearchParams({ path: filePath });
  if (kind === 'text') {
    query.set('mode', mode);
    return `/api/sessions/${sessionId}/diff?${query}`;
  }
  query.set('side', kind === 'image-old' ? 'old' : 'new');
  return `/api/sessions/${sessionId}/diff/file?${query}`;
}

export async function fetchOneReviewDiff({
  client,
  sessionId,
  path,
  mode,
  file,
}: {
  client: HostClient;
  sessionId: string;
  path: string;
  mode: 'staged' | 'unstaged';
  file: DiffFileStat;
}): Promise<ReviewDiffSlot> {
  try {
    if (file.binary && isImagePath(path)) {
      const [oldUri, newUri] = await Promise.all([
        fetchDiffImageUri(client, reviewDiffRequestPath(sessionId, path, mode, 'image-old')),
        fetchDiffImageUri(client, reviewDiffRequestPath(sessionId, path, mode, 'image-new')),
      ]);
      return { status: 'image', old: oldUri, new: newUri };
    }
    const res = await client.get(reviewDiffRequestPath(sessionId, path, mode, 'text'));
    const body = (await res.json().catch(() => ({}))) as {
      diff?: string;
      truncated?: boolean;
      error?: string;
    };
    if (!res.ok || typeof body.diff !== 'string') {
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return { status: 'ready', text: body.diff, truncated: body.truncated === true };
  } catch (error) {
    return { status: 'error', message: String(error) };
  }
}
