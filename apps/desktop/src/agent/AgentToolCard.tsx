import { useState } from 'react';
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

/** Pretty-print the tool input JSON, falling back to the raw string. */
function formatInput(inputJson: string): string {
  try {
    return JSON.stringify(JSON.parse(inputJson), null, 2);
  } catch {
    return inputJson;
  }
}

/** Console-style card for one tool invocation; the header toggles an expandable
 * body showing the diff (or raw arguments) and result. Port of Swift
 * AgentToolCard. */
export function AgentToolCard({ tool }: { tool: AgentToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const style = toolStyle(tool.name);
  return (
    <div className={`agent-tool-card agent-tool-${style.accent}`}>
      <button
        type="button"
        className="agent-tool-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="agent-tool-glyph">{style.glyph}</span>
        <span className="agent-tool-name">{tool.name}</span>
        <span className="agent-tool-summary">{tool.summary}</span>
        {tool.isError ? <span className="agent-tool-err">⚠</span> : null}
        <span className="agent-tool-chevron">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded ? (
        <div className="agent-tool-body">
          {tool.diff ? (
            <ToolDiff diff={tool.diff} />
          ) : (
            <pre className="agent-tool-input">{formatInput(tool.inputJson)}</pre>
          )}
          {tool.result ? (
            <pre className={`agent-tool-result${tool.isError ? ' error' : ''}`}>{tool.result}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
