import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { coreDeepLinkResolve } from './coreApi';
import type { HostProfile } from './types';

/**
 * Resolve `tether://session/<id>?host=<identityName>` via the Rust parser
 * (`core_deep_link_resolve`). Queues until profiles are ready.
 */
export function useDeepLinks({
  ready,
  profiles,
  onSession,
}: {
  ready: boolean;
  profiles: HostProfile[];
  onSession: (hostId: string, sessionId: string) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  const handleUrl = useCallback(async (url: string) => {
    if (!profilesRef.current.length) {
      pendingRef.current = url;
      return;
    }
    try {
      const result = await coreDeepLinkResolve(url);
      if (result.kind === 'matched') {
        onSessionRef.current(result.hostId, result.sessionId);
      } else if (result.kind === 'unknownHost') {
        setNotice(`No saved host named “${result.identityName}”.`);
      }
    } catch {
      // Ignore malformed / plugin errors.
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const current = await getCurrent();
        if (current) {
          for (const url of current) {
            if (!disposed) await handleUrl(url);
          }
        }
        unlisten = await onOpenUrl((urls) => {
          for (const url of urls) void handleUrl(url);
        });
      } catch {
        // Plugin may be unavailable in plain browser preview.
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ready, handleUrl]);

  useEffect(() => {
    if (!ready || !profiles.length || !pendingRef.current) return;
    const url = pendingRef.current;
    pendingRef.current = null;
    void handleUrl(url);
  }, [ready, profiles, handleUrl]);

  return {
    deepLinkNotice: notice,
    dismissDeepLinkNotice: () => setNotice(null),
  };
}
