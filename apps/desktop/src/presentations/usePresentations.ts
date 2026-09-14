import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { corePresentationClose, corePresentationContent, corePresentationsList } from '@/workspace/workspaceApi';
import { findSessionPreview, type Presentation, pickAutoSelectPreview } from '@/workspace/workspaceTypes';

export function usePresentations({
  hostId,
  sessionId,
  enabled,
}: {
  hostId: string | null;
  sessionId: string;
  enabled: boolean;
}) {
  const [presentations, setPresentations] = useState<Presentation[]>([]);
  const [activePresentationId, setActivePresentationId] = useState<string | null>(null);
  const seenIds = useRef(new Set<string>());
  const primed = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const refreshPresentations = useCallback(async () => {
    if (!hostId || !enabled) return;
    try {
      const rows = await corePresentationsList(hostId);
      if (!primed.current) {
        primed.current = true;
        seenIds.current = new Set(rows.map((preview) => preview.id));
        setPresentations(rows);
        return;
      }
      const auto = pickAutoSelectPreview(rows, seenIds.current, sessionIdRef.current);
      seenIds.current = new Set(rows.map((preview) => preview.id));
      setPresentations(rows);
      if (auto) setActivePresentationId(auto.id);
      else
        setActivePresentationId((current) =>
          current && !rows.some((preview) => preview.id === current) ? null : current,
        );
    } catch {
      // polling is best-effort
    }
  }, [hostId, enabled]);

  useEffect(() => {
    if (!enabled || !hostId) return undefined;
    primed.current = false;
    void refreshPresentations();
    const interval = setInterval(() => void refreshPresentations(), 4000);
    return () => clearInterval(interval);
  }, [enabled, hostId, refreshPresentations]);

  const activePresentation = useMemo(
    () => presentations.find((preview) => preview.id === activePresentationId) ?? null,
    [presentations, activePresentationId],
  );

  const sessionPreview = useMemo(() => findSessionPreview(presentations, sessionId), [presentations, sessionId]);

  const activePresentationHtml = useActivePresentationHtml(hostId, activePresentation);

  const closePresentation = useCallback(
    async (id: string) => {
      if (!hostId) return;
      try {
        const ok = await corePresentationClose(hostId, id);
        if (ok) {
          if (activePresentationId === id) setActivePresentationId(null);
          await refreshPresentations();
        }
      } catch {}
    },
    [hostId, activePresentationId, refreshPresentations],
  );

  return {
    presentations,
    sessionPreview,
    activePresentation,
    activePresentationHtml,
    activePresentationId,
    setActivePresentationId,
    closePresentation,
  };
}

// The self-contained HTML travels over the authed content route, refetched
// whenever the active preview or its revision changes. Nothing is loaded by URL.
function useActivePresentationHtml(hostId: string | null, activePresentation: Presentation | null) {
  const [html, setHtml] = useState<string | null>(null);
  const activeId = activePresentation?.id ?? null;
  const activeRevision = activePresentation?.revision ?? null;
  useEffect(() => {
    if (!hostId || activeId === null) {
      setHtml(null);
      return undefined;
    }
    // activeRevision is a refetch trigger: a bumped revision means the inlined
    // HTML changed on the server, so re-pull it even though the id is unchanged.
    void activeRevision;
    let cancelled = false;
    void corePresentationContent(hostId, activeId)
      .then((next) => !cancelled && setHtml(next))
      .catch(() => !cancelled && setHtml(null));
    return () => {
      cancelled = true;
    };
  }, [hostId, activeId, activeRevision]);
  return html;
}
