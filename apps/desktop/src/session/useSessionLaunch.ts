import { useState } from 'react';
import type { ViewStateApi } from '@/pane/useViewState';
import { newSoloView } from '@/pane/viewModel';
import type { TetherDesktop } from '@/shell/useTetherDesktop';

export interface UseSessionLaunchOpts {
  app: TetherDesktop;
  viewState: ViewStateApi;
  /** Close the overlay drawer after a launch; a no-op when the sidebar is docked. */
  onLaunched: () => void;
}

export function useSessionLaunch({ app, viewState, onLaunched }: UseSessionLaunchOpts) {
  const [agentChatFor, setAgentChatFor] = useState<string | null>(null);

  const startAgentChat = (cwd: string) => {
    const hostId = agentChatFor;
    setAgentChatFor(null);
    if (!hostId) return;
    void app.newAgentChat(hostId).then((sessionId) => {
      if (!sessionId) return;
      viewState.addSoloView(newSoloView({ hostId, sessionId, kind: 'agent', cwd }));
    });
    onLaunched();
  };

  return {
    agentChatFor,
    setAgentChatFor,
    newTerminalOn: (hostId: string | null) => {
      if (!hostId) return;
      void app.newSession(hostId).then((sessionId) => {
        if (sessionId) viewState.openSession(hostId, sessionId);
      });
      onLaunched();
    },
    newAgentChatOn: (hostId: string | null) => {
      if (hostId) setAgentChatFor(hostId);
    },
    startAgentChat,
    // /resume: open the picked past Claude session in a fresh agent tab.
    resumeAgentChat: (hostId: string, cwd: string | undefined, claudeSessionId: string) => {
      void app.newAgentChat(hostId).then((sessionId) => {
        if (!sessionId) return;
        viewState.addSoloView(newSoloView({ hostId, sessionId, kind: 'agent', cwd, resumeSessionId: claudeSessionId }));
      });
    },
  };
}

export type SessionLaunch = ReturnType<typeof useSessionLaunch>;
