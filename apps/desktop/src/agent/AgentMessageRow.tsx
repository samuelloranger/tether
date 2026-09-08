import { AgentToolCard } from './AgentToolCard';
import type { AgentMessage, AgentUsage } from './agentTypes';
import { ProseMarkdown } from './ProseMarkdown';

function UsageFooter({ usage }: { usage: AgentUsage }) {
  const cost = usage.costUsd != null ? ` · $${usage.costUsd.toFixed(4)}` : '';
  return (
    <div className="agent-usage-footer">
      {usage.inputTokens}↑ {usage.outputTokens}↓{cost}
    </div>
  );
}

/** One transcript row: user bubble, assistant turn, or error. Port of Swift
 * AgentMessageRow (AgentChatView.swift:256). */
export function AgentMessageRow({ message }: { message: AgentMessage }) {
  if (message.role === 'error') {
    const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return <div className="agent-row agent-row-error">{text}</div>;
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
      </div>
      {message.usage ? <UsageFooter usage={message.usage} /> : null}
    </div>
  );
}
