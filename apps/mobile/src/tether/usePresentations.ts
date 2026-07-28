// biome-ignore-all lint/correctness/useExhaustiveDependencies: polling is deliberately keyed by configuration changes.
import { useEffect, useRef, useState } from 'react';
import type { Presentation } from '../presentations';
import { pickAutoSelectPreview } from '../presentations';
import type { HostClient } from './hostClient';

type Options = {
  client: HostClient;
  isConfiguring: boolean;
  getActiveSessionId: () => string;
  markAuthFailed: () => void;
};

export function usePresentations({
  client,
  isConfiguring,
  getActiveSessionId,
  markAuthFailed,
}: Options) {
  const [presentations, setPresentations] = useState<Presentation[]>([]);
  const [activePresentationId, setActivePresentationId] = useState<string | null>(null);
  const seenIds = useRef(new Set<string>());
  const primed = useRef(false);
  const refreshPresentations = async () => {
    try {
      const response = await client.get('/api/presentations');
      if (response.status === 401) {
        markAuthFailed();
        return;
      }
      if (!response.ok) return;
      const rows = (await response.json()) as Presentation[];
      if (!primed.current) {
        primed.current = true;
        seenIds.current = new Set(rows.map((preview) => preview.id));
        setPresentations(rows);
        return;
      }
      const newPreview = pickAutoSelectPreview(rows, seenIds.current, getActiveSessionId());
      seenIds.current = new Set(rows.map((preview) => preview.id));
      setPresentations(rows);
      if (newPreview) setActivePresentationId(newPreview.id);
      else
        setActivePresentationId((current) =>
          current && !rows.some((preview) => preview.id === current) ? null : current,
        );
    } catch {}
  };
  const closePresentation = async (id: string) => {
    try {
      const response = await client.get(`/api/presentations/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) return;
      if (activePresentationId === id) setActivePresentationId(null);
      await refreshPresentations();
    } catch {}
  };
  useEffect(() => {
    if (isConfiguring) return;
    let hidden = false;
    const tick = () => {
      if (!hidden) void refreshPresentations();
    };
    tick();
    const interval = setInterval(tick, 4000);
    const onVisibilityChange = () => {
      hidden = document.hidden;
      if (!hidden) tick();
    };
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(interval);
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [client, isConfiguring]);
  return {
    presentations,
    activePresentationId,
    setActivePresentationId,
    refreshPresentations,
    closePresentation,
  };
}
