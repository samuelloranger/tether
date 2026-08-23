import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { createDeepLinkHandler, listenForDeepLinks } from '../deepLink';
import { isDesktop, isTauri } from '../platform';
import type { HostProfile } from './hostStore';
import {
  addNotificationResponseReceivedListener,
  useLastNotificationResponse,
} from './notifications';
import { linkFromNotificationResponse } from './pushDeepLink';

export function useDeepLinks({
  profiles,
  onSession,
}: {
  profiles: HostProfile[] | null;
  onSession: (hostId: string, sessionId: string) => void;
}) {
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | null>(null);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const deepLinkHandlerRef = useRef<ReturnType<typeof createDeepLinkHandler> | null>(null);
  if (!deepLinkHandlerRef.current)
    deepLinkHandlerRef.current = createDeepLinkHandler({
      getProfiles: () => profilesRef.current,
      onSession: (hostId, sessionId) => onSessionRef.current(hostId, sessionId),
    });
  const handleDeepLink = useCallback((url: string) => {
    const result = deepLinkHandlerRef.current?.handle(url);
    if (result?.kind === 'unknown-host')
      setDeepLinkNotice(`No saved host named “${result.identityName}”.`);
  }, []);
  const handleDeepLinkRef = useRef(handleDeepLink);
  handleDeepLinkRef.current = handleDeepLink;
  const lastNotificationResponse = useLastNotificationResponse();
  useEffect(() => {
    const link = linkFromNotificationResponse(lastNotificationResponse);
    if (link) handleDeepLinkRef.current(link);
  }, [lastNotificationResponse]);
  useEffect(() => {
    let disposed = false;
    let stopDesktopListener: (() => void) | undefined;
    const handleUrl = (url: string) => handleDeepLinkRef.current(url);
    void Linking.getInitialURL()
      .then((url) => {
        if (url) handleUrl(url);
      })
      .catch(() => {});
    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    const notificationSub = addNotificationResponseReceivedListener((response) => {
      const link = linkFromNotificationResponse(response);
      if (link) handleUrl(link);
    });
    if (isDesktop && isTauri())
      void import('@tauri-apps/plugin-deep-link')
        .then(({ getCurrent, onOpenUrl }) =>
          listenForDeepLinks({ getCurrent, onOpenUrl, onUrl: handleUrl }),
        )
        .then((stop) => {
          if (disposed) stop();
          else stopDesktopListener = stop;
        })
        .catch(() => {});
    return () => {
      disposed = true;
      subscription.remove();
      notificationSub.remove();
      stopDesktopListener?.();
    };
  }, []);
  useEffect(() => {
    if (profiles === null) return;
    const result = deepLinkHandlerRef.current?.applyPending();
    if (result?.kind === 'unknown-host')
      setDeepLinkNotice(`No saved host named “${result.identityName}”.`);
  }, [profiles]);
  return {
    deepLinkNotice,
    dismissDeepLinkNotice: () => setDeepLinkNotice(null),
  };
}
