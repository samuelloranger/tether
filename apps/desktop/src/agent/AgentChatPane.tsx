import { useEffect, useRef } from 'react';
import { AgentComposer } from './AgentComposer';
import { AgentMessageRow } from './AgentMessageRow';
import { agentPrompt } from './agentFrames';
import { useAgentChat } from './useAgentChat';

/** Full agent chat surface: transcript (auto-following) + composer. Port of
 * Swift AgentChatView + AgentTranscriptView. */
export function AgentChatPane({
  hostId,
  sessionId,
  noiseAddress,
  cwd,
}: {
  hostId: string;
  sessionId: string;
  noiseAddress: string;
  cwd?: string;
}) {
  const { model, snapshot, send } = useAgentChat({ hostId, sessionId, noiseAddress, cwd });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  // Auto-follow: stick to the bottom while the user is already there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the scroll trigger
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [snapshot.revision]);

  // Drain one queued prompt when the turn returns to idle.
  useEffect(() => {
    if (snapshot.turn === 'idle' && snapshot.queued.length > 0) {
      const next = model.dequeue();
      if (next) {
        model.pushUserPrompt(next);
        send(agentPrompt(next));
      }
    }
  }, [snapshot.turn, snapshot.queued.length, model, send]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="agent-pane">
      <div className="agent-transcript" ref={scrollRef} onScroll={onScroll}>
        {snapshot.messages.length === 0 ? (
          <div className="agent-empty">Ask Claude Code anything.</div>
        ) : (
          snapshot.messages.map((m) => <AgentMessageRow key={m.id} message={m} />)
        )}
      </div>
      <AgentComposer model={model} snapshot={snapshot} send={send} />
    </div>
  );
}
