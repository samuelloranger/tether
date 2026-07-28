// biome-ignore-all lint/correctness/useExhaustiveDependencies: polling is deliberately keyed by configuration changes.
import { useEffect, useRef, useState } from 'react';
import { httpBase } from '../address';
import type { Presentation } from '../presentations';
import { pickAutoSelectPreview } from '../presentations';
import { authHeaders } from '../secureConfig';
import type { ConnectionStatus } from './types';

type Options = {
  serverIp: string;
  port: string;
  passwordRef: React.MutableRefObject<string>;
  isConfiguring: boolean;
  activeIdRef: React.MutableRefObject<string>;
  setConnectionStatus: React.Dispatch<React.SetStateAction<ConnectionStatus>>;
};

export function usePresentations({
  serverIp,
  port,
  passwordRef,
  isConfiguring,
  activeIdRef,
  setConnectionStatus,
}: Options) {
  const [presentations, setPresentations] = useState<Presentation[]>([]);
  const [activePresentationId, setActivePresentationId] = useState<string | null>(null);
  const seenIds = useRef(new Set<string>());
  const primed = useRef(false);
  const refreshPresentations = async () => {
    try {
      const response = await fetch(`${httpBase(serverIp, port)}/api/presentations`, {
        headers: authHeaders(passwordRef.current),
      });
      if (response.status === 401) {
        setConnectionStatus('auth-failed');
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
      const newPreview = pickAutoSelectPreview(rows, seenIds.current, activeIdRef.current);
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
      const response = await fetch(`${httpBase(serverIp, port)}/api/presentations/${id}`, {
        method: 'DELETE',
        headers: authHeaders(passwordRef.current),
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
  }, [isConfiguring, serverIp, port]);
  return {
    presentations,
    activePresentationId,
    setActivePresentationId,
    refreshPresentations,
    closePresentation,
  };
}
