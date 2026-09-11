import { AgentInfoStrip } from './AgentInfoStrip';
import { AgentPalette } from './AgentPalette';
import type { AgentChatModel, AgentSnapshot } from './agentChatModel';
import { agentInterrupt } from './agentFrames';
import { useAgentComposer } from './useAgentComposer';

/** Input bar: prompt/queue, send/stop, permission approve/deny, and the
 * slash-command palette. Port of Swift AgentComposerView + QueuedRow. */
export function AgentComposer({
  model,
  snapshot,
  send,
}: {
  model: AgentChatModel;
  snapshot: AgentSnapshot;
  send: (payload: unknown) => void;
}) {
  const { draft, turn, queued, pendingApproval, sessionUsage, status } = snapshot;
  const streaming = turn !== 'idle';
  const { matches, paletteOpen, submit, runCommand, onKeyDown, resolve } = useAgentComposer(model, snapshot, send);

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

      {paletteOpen ? <AgentPalette matches={matches} index={snapshot.paletteIndex} onRun={runCommand} /> : null}

      <AgentInfoStrip status={status} sessionUsage={sessionUsage} />

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
          <button type="button" className="agent-stop" onClick={() => send(agentInterrupt())} aria-label="Stop">
            ■
          </button>
        ) : (
          <button type="button" className="agent-send" onClick={submit} disabled={!draft.trim()} aria-label="Send">
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
