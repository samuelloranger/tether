import { useCallback, useState } from 'react';
import { Linking } from 'react-native';
import { openExternalUrl } from '../desktopUpdate';
import { notify } from '../dialog';
import type { FileView } from '../fileView';
import type { LinkTarget } from '../links';
import { isDesktop } from '../platform';
import type { HostClient } from './hostClient';

export function useFileView({
  client,
  getActiveSessionId,
}: {
  client: HostClient;
  getActiveSessionId: () => string;
}) {
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const closeFile = useCallback(() => setFileView(null), []);
  const openFile = useCallback(
    async (target: LinkTarget) => {
      if (target.kind === 'external') {
        try {
          if (isDesktop) await openExternalUrl(target.url);
          else await Linking.openURL(target.url);
        } catch (error) {
          void notify('Could not open link', String(error), 'error');
        }
        return;
      }
      setFileLoading(true);
      try {
        const sessionId = getActiveSessionId();
        const query = new URLSearchParams({ path: target.path });
        const res = await client.get(`/api/sessions/${sessionId}/file?${query}`);
        const body = (await res.json().catch(() => ({}))) as {
          path?: string;
          content?: string;
          error?: string;
        };
        if (!res.ok || typeof body.path !== 'string' || typeof body.content !== 'string') {
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        if (getActiveSessionId() === sessionId) {
          setFileView({
            path: body.path,
            content: body.content,
            line: target.line,
            column: target.column,
          });
        }
      } catch (error) {
        void notify('Could not open file', String(error), 'error');
      } finally {
        setFileLoading(false);
      }
    },
    [client, getActiveSessionId],
  );
  return { fileView, fileLoading, closeFile, openFile };
}
