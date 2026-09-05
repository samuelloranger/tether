import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { corePresentationClose, corePresentationsList } from './workspaceApi';
import {
  findSessionPreview,
  type Presentation,
  pickAutoSelectPreview,
  previewUrl,
} from './workspaceTypes';

export function usePresentations({
  hostId,
  sessionId,
  baseUrl,
  enabled,
}: {
  hostId: string | null;
  sessionId: string;
  baseUrl: string | null;
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

  const sessionPreview = useMemo(
    () => findSessionPreview(presentations, sessionId),
    [presentations, sessionId],
  );

  const activePresentationUrl = useMemo(() => {
    if (!activePresentation || !baseUrl) return null;
    return previewUrl(baseUrl, activePresentation.url);
  }, [activePresentation, baseUrl]);

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
    activePresentationUrl,
    activePresentationId,
    setActivePresentationId,
    closePresentation,
  };
}
