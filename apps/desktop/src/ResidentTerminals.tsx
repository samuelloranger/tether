import { useEffect, useState } from 'react';
import { coreCacheDelete, coreCacheIds, coreCacheTouch } from './coreApi';
import type { FrameApplyResult } from './frameHandler';
import type { UI_THEMES } from './preferences';
import { parseSessionKey, sessionKey } from './sessionKey';
import { TerminalPane } from './TerminalPane';
import type { DrawerSession, HostProfile } from './types';
import { wsOriginFor } from './types';

export interface ResidentTerminalsProps {
  hosts: HostProfile[];
  passwords: Record<string, string>;
  sessions: DrawerSession[];
  activeHostId: string | null;
  activeSessionId: string;
  terminalTheme: (typeof UI_THEMES)[keyof typeof UI_THEMES]['terminal'];
  fontFamily: string;
  fontSize?: number;
  onFrame: (hostId: string, sessionId: string, frame: FrameApplyResult) => void;
  onDisconnected: (hostId: string) => void;
}

export function ResidentTerminals(props: ResidentTerminalsProps) {
  const [resident, setResident] = useState<string[]>([]);
  const activeKey =
    props.activeHostId && props.activeSessionId
      ? sessionKey(props.activeHostId, props.activeSessionId)
      : null;

  useEffect(() => {
    if (!activeKey) {
      setResident([]);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      await coreCacheTouch(activeKey);
      const valid = new Set(props.sessions.map((row) => sessionKey(row.hostId, row.id)));
      const ids = await coreCacheIds();
      for (const id of ids) {
        if (!valid.has(id) && id !== activeKey) await coreCacheDelete(id);
      }
      if (!cancelled) setResident(await coreCacheIds());
    })();
    return () => {
      cancelled = true;
    };
  }, [activeKey, props.sessions]);

  if (!activeKey) return null;

  return (
    <div className="resident-terminals">
      {resident.map((key) => {
        const { hostId, sessionId } = parseSessionKey(key);
        const host = props.hosts.find((row) => row.id === hostId);
        if (!host) return null;
        return (
          <TerminalPane
            key={key}
            hostId={hostId}
            sessionId={sessionId}
            interactive={key === activeKey}
            wsOrigin={wsOriginFor(host)}
            password={props.passwords[hostId] ?? ''}
            terminalTheme={props.terminalTheme}
            fontFamily={props.fontFamily}
            fontSize={props.fontSize}
            onFrame={props.onFrame}
            onDisconnected={() => props.onDisconnected(hostId)}
          />
        );
      })}
    </div>
  );
}
