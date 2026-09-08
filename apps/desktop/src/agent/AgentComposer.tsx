import type { KeyboardEvent } from 'react';
import type { AgentChatModel, AgentSnapshot } from './agentChatModel';
import { agentInterrupt, agentPermission, agentPrompt } from './agentFrames';

/** Input bar: prompt/queue, send/stop, and permission approve/deny. Port of
 * Swift AgentComposerView + QueuedRow + permission UI. */
export function AgentComposer({
  model,
  snapshot,
  send,
}: {
  model: AgentChatModel;
  snapshot: AgentSnapshot;
  send: (payload: unknown) => void;
}) {
  const { draft, turn, queued, pendingApproval } = snapshot;
  const streaming = turn !== 'idle';

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (streaming) {
      model.enqueue(text);
    } else {
      model.pushUserPrompt(text);
      send(agentPrompt(text));
    }
    model.setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const resolve = (allow: boolean) => {
    const r = model.resolvePermission(allow);
    if (r) send(agentPermission({ reqId: r.id, allow }));
  };

  return (
    <div className="agent-composer">
      {pendingApproval ? (
        <div className="agent-permission">
          <span className="agent-permission-text">
            Allow <strong>{pendingApproval.name}</strong>? {pendingApproval.summary}
          </span>
          <div className="agent-permission-actions">
            <button type="button" className="agent-approve" onClick={() => resolve(true)}>
              Approve
            </button>
            <button type="button" className="agent-deny" onClick={() => resolve(false)}>
              Deny
            </button>
          </div>
        </div>
      ) : null}

      {queued.length > 0 ? (
        <div className="agent-queued">
          {queued.map((q, i) => (
            <button
              type="button"
              // biome-ignore lint/suspicious/noArrayIndexKey: positional queue rows
              key={i}
              className="agent-queued-row"
              title="Cancel queued message"
              onClick={() => model.removeQueued(i)}
            >
              <span className="agent-queued-glyph" aria-hidden>
                ◷
              </span>
              <span className="agent-queued-text">{q}</span>
              <span className="agent-queued-x" aria-hidden>
                ×
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="agent-composer-input">
        <textarea
          className="agent-textarea"
          placeholder="Message Claude Code…"
          value={draft}
          onChange={(e) => model.setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
        />
        {streaming ? (
          <button
            type="button"
            className="agent-stop"
            onClick={() => send(agentInterrupt())}
            aria-label="Stop"
          >
            ■
          </button>
        ) : (
          <button
            type="button"
            className="agent-send"
            onClick={submit}
            disabled={!draft.trim()}
            aria-label="Send"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
