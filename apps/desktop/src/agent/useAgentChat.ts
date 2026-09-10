import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { type AgentBinding, bindAgentSession } from './agentBind';
import { AgentChatModel } from './agentChatModel';

/**
 * React binding for one agent chat. Keeps a stable AgentChatModel, wires it to
 * the Noise socket for the lifetime of the mount, re-renders on reducer changes
 * (useSyncExternalStore), and exposes `send` for outbound frames.
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
  const bindingRef = useRef<AgentBinding | null>(null);

  useEffect(() => {
    const binding = bindAgentSession({
      model,
      hostId: input.hostId,
      sessionId: input.sessionId,
      noiseAddress: input.noiseAddress,
      cwd: input.cwd,
    });
    bindingRef.current = binding;
    return () => {
      binding.close();
      bindingRef.current = null;
    };
  }, [model, input.hostId, input.sessionId, input.noiseAddress, input.cwd]);

  const send = useCallback((payload: unknown) => {
    bindingRef.current?.send(payload);
  }, []);

  return { model, snapshot, send };
}
