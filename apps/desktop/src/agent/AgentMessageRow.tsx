import { AgentToolCard } from './AgentToolCard';
import { type AgentMessage, type AgentUsage, formatCost, formatTokens } from './agentTypes';
import { ProseMarkdown } from './ProseMarkdown';

function UsageFooter({ usage }: { usage: AgentUsage }) {
  const tokens =
    usage.inputTokens || usage.outputTokens
      ? `${formatTokens(usage.inputTokens)}↑ ${formatTokens(usage.outputTokens)}↓`
      : '';
  const cost = usage.costUsd ? formatCost(usage.costUsd) : '';
  const text = [tokens, cost].filter(Boolean).join(' · ');
  return text ? <div className="agent-usage-footer">{text}</div> : null;
}

/** One transcript row: user bubble, assistant turn, or error. Port of Swift
 * AgentMessageRow (AgentChatView.swift:256). */
export function AgentMessageRow({
  message,
  onRetry,
}: {
  message: AgentMessage;
  onRetry?: () => void;
}) {
  if (message.role === 'error') {
    const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return (
      <div className="agent-row agent-row-error">
        <span className="agent-error-text">{text}</span>
        {onRetry ? (
          <button type="button" className="agent-retry" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  const isUser = message.role === 'user';
  return (
    <div className={`agent-row ${isUser ? 'agent-row-user' : 'agent-row-assistant'}`}>
      <div className={isUser ? 'agent-bubble-user' : 'agent-turn'}>
        {message.blocks.map((block, i) =>
          block.type === 'text' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional blocks
            <ProseMarkdown key={i} text={block.text} />
          ) : (
            <AgentToolCard key={block.tool.id} tool={block.tool} />
          ),
        )}
        {message.isStreaming ? <span className="agent-caret" aria-hidden /> : null}
      </div>
      {message.usage ? <UsageFooter usage={message.usage} /> : null}
    </div>
  );
}
