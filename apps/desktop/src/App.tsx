import { useCallback, useState } from 'react';
import { ConnectScreen } from './ConnectScreen';
import type { HostConfig } from './hostClient';
import { SessionListScreen } from './SessionListScreen';
import { TerminalPane } from './TerminalPane';

type Screen = 'connect' | 'sessions' | 'terminal';

export function App() {
  const [screen, setScreen] = useState<Screen>('connect');
  const [config, setConfig] = useState<HostConfig | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const openSession = useCallback((id: string) => {
    setSessionId(id);
    setScreen('terminal');
  }, []);

  const backToSessions = useCallback(() => {
    setSessionId(null);
    setScreen('sessions');
  }, []);

  if (screen === 'connect' || !config) {
    return (
      <ConnectScreen
        onConnected={(next) => {
          setConfig(next);
          setScreen('sessions');
        }}
      />
    );
  }

  if (screen === 'sessions') {
    return (
      <SessionListScreen
        config={config}
        onOpenSession={openSession}
        onDisconnect={() => {
          setConfig(null);
          setScreen('connect');
        }}
      />
    );
  }

  if (screen === 'terminal' && sessionId) {
    return (
      <div className="terminal-screen">
        <header className="terminal-toolbar">
          <button type="button" className="secondary" onClick={backToSessions}>
            ← Sessions
          </button>
          <span className="terminal-label">{sessionId}</span>
        </header>
        <TerminalPane
          wsOrigin={`ws://${config.host}:${config.port}`}
          password={config.password}
          sessionId={sessionId}
          onDisconnected={backToSessions}
        />
      </div>
    );
  }

  return (
    <SessionListScreen
      config={config}
      onOpenSession={openSession}
      onDisconnect={() => {
        setConfig(null);
        setScreen('connect');
      }}
    />
  );
}
