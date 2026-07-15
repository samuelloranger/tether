import { httpBase } from './address';

export interface Presentation {
  id: string;
  title: string;
  project: string;
  revision: number;
  url: string;
  sessionId?: string;
}

export function previewUrl(serverIp: string, port: string, url: string): string {
  return new URL(url, httpBase(serverIp, port)).toString();
}

// The most recently created open preview owned by a given terminal session —
// drives the "preview ready" banner on that session's terminal screen.
export function findSessionPreview(
  presentations: Presentation[],
  sessionId: string,
): Presentation | null {
  let match: Presentation | null = null;
  for (const preview of presentations) {
    if (preview.sessionId === sessionId) match = preview;
  }
  return match;
}

// A preview auto-selects (forces navigation) only when it's both new to this
// client (`seen`) and owned by the session the client is currently looking
// at — otherwise every connected client would jump to every new preview
// regardless of which session created it.
export function pickAutoSelectPreview(
  rows: Presentation[],
  seen: ReadonlySet<string>,
  activeId: string,
): Presentation | null {
  return rows.find((preview) => !seen.has(preview.id) && preview.sessionId === activeId) ?? null;
}
