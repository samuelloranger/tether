import { useEffect, useRef, useSyncExternalStore } from 'react';
import { bindAgentSession } from './agentBind';
import { AgentChatModel } from './agentChatModel';

/**
 * React binding for one agent chat. Keeps a stable AgentChatModel, wires it to
 * the Noise socket for the lifetime of the mount, and re-renders on reducer
 * changes via useSyncExternalStore.
 */
export function useAgentChat(input: {
  hostId: string;
  sessionId: string;
  noiseAddress: string;
  cwd?: string;
}) {
  const modelRef = useRef<AgentChatModel | null>(null);
  if (!modelRef.current) modelRef.current = new AgentChatModel();
  const model = modelRef.current;

  const snapshot = useSyncExternalStore(model.subscribe, model.snapshot);

  useEffect(() => {
    const binding = bindAgentSession({
      model,
      hostId: input.hostId,
      sessionId: input.sessionId,
      noiseAddress: input.noiseAddress,
      cwd: input.cwd,
    });
    return () => binding.close();
  }, [model, input.hostId, input.sessionId, input.noiseAddress, input.cwd]);

  return { model, snapshot };
}
