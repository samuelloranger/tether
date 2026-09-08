import { highlightLine } from '../git/codeHighlight';
import type { AgentToolCall, DerivedDiff } from './agentTypes';
import { toolStyle } from './agentTypes';

function ToolDiff({ diff }: { diff: DerivedDiff }) {
  return (
    <div className="agent-tool-diff">
      {diff.hunks.flatMap((hunk, hi) =>
        hunk.lines.map((line, li) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional diff lines
          <div key={`${hi}-${li}`} className={`agent-diff-row agent-diff-${line.kind}`}>
            <span className="agent-diff-marker">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
            </span>
            <span className="agent-diff-code">
              {highlightLine(line.text, null).map((tok, ti) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional tokens
                <span key={ti} className={tok.className}>
                  {tok.text}
                </span>
              ))}
            </span>
          </div>
        )),
      )}
    </div>
  );
}

/** Console-style card for one tool invocation. Port of Swift AgentToolCard. */
export function AgentToolCard({ tool }: { tool: AgentToolCall }) {
  const style = toolStyle(tool.name);
  return (
    <div className={`agent-tool-card agent-tool-${style.accent}`}>
      <div className="agent-tool-head">
        <span className="agent-tool-glyph">{style.glyph}</span>
        <span className="agent-tool-name">{tool.name}</span>
        <span className="agent-tool-summary">{tool.summary}</span>
      </div>
      {tool.diff ? <ToolDiff diff={tool.diff} /> : null}
      {tool.result ? (
        <pre className={`agent-tool-result${tool.isError ? ' error' : ''}`}>{tool.result}</pre>
      ) : null}
    </div>
  );
}
