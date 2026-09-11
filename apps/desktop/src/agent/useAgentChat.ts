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
  resumeSessionId?: string;
}) {
  const modelRef = useRef<AgentChatModel | null>(null);
  if (!modelRef.current) modelRef.current = new AgentChatModel();
  const model = modelRef.current;

  // Third arg is the server snapshot: unused by the running app (it never
  // hydrates), required by renderToString in the golden tests.
  const snapshot = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const bindingRef = useRef<AgentBinding | null>(null);

  useEffect(() => {
    const binding = bindAgentSession({
      model,
      hostId: input.hostId,
      sessionId: input.sessionId,
      noiseAddress: input.noiseAddress,
      cwd: input.cwd,
      resumeSessionId: input.resumeSessionId,
    });
    bindingRef.current = binding;
    return () => {
      binding.close();
      bindingRef.current = null;
    };
  }, [model, input.hostId, input.sessionId, input.noiseAddress, input.cwd, input.resumeSessionId]);

  const send = useCallback((payload: unknown) => {
    bindingRef.current?.send(payload);
  }, []);

  return { model, snapshot, send };
}
