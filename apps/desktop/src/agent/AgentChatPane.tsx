import { useEffect, useRef } from 'react';
import { AgentComposer } from './AgentComposer';
import { AgentMessageRow } from './AgentMessageRow';
import { AgentPanePickers } from './AgentPanePickers';
import { agentListSessions, agentPrompt } from './agentFrames';
import type { ClaudeSessionMeta } from './agentTypes';
import { useAgentChat } from './useAgentChat';

/** Full agent chat surface: transcript (auto-following) + composer. Port of
 * Swift AgentChatView + AgentTranscriptView. */
export function AgentChatPane({
  hostId,
  sessionId,
  noiseAddress,
  cwd,
  resumeSessionId,
  onResumeSession,
}: {
  hostId: string;
  sessionId: string;
  noiseAddress: string;
  cwd?: string;
  resumeSessionId?: string;
  onResumeSession?: (session: ClaudeSessionMeta) => void;
}) {
  const { model, snapshot, send } = useAgentChat({
    hostId,
    sessionId,
    noiseAddress,
    cwd,
    resumeSessionId,
  });
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
        model.notePromptSent();
        send(agentPrompt(next));
      }
    }
  }, [snapshot.turn, snapshot.queued.length, model, send]);

  // Fetch the past-session list once when the /resume picker opens.
  useEffect(() => {
    if (snapshot.pendingPicker === 'resume') send(agentListSessions(cwd ?? ''));
  }, [snapshot.pendingPicker, cwd, send]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const retryLast = () => {
    const prompt = model.retryLast();
    if (prompt) send(agentPrompt(prompt));
  };

  const basename = cwd?.replace(/\/+$/, '').split('/').at(-1);
  const lastIndex = snapshot.messages.length - 1;

  return (
    <div className="agent-pane">
      <div className="agent-transcript" ref={scrollRef} onScroll={onScroll}>
        {snapshot.messages.length === 0 ? (
          <div className="agent-empty">
            <div className="agent-empty-title">Ask Claude Code</div>
            {basename ? <div className="agent-empty-cwd">{basename}</div> : null}
          </div>
        ) : (
          snapshot.messages.map((m, i) => (
            <AgentMessageRow
              key={m.id}
              message={m}
              onRetry={i === lastIndex && m.role === 'error' && snapshot.canRetry ? retryLast : undefined}
            />
          ))
        )}
        {snapshot.turn === 'thinking' ? (
          <div className="agent-thinking" role="status" aria-label="Thinking">
            <span className="agent-thinking-dot" />
            <span className="agent-thinking-dot" />
            <span className="agent-thinking-dot" />
          </div>
        ) : null}
      </div>
      <AgentComposer model={model} snapshot={snapshot} send={send} />
      <AgentPanePickers model={model} snapshot={snapshot} send={send} cwd={cwd} onResumeSession={onResumeSession} />
    </div>
  );
}
