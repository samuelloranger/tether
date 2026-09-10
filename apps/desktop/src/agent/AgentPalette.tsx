import type { AgentCommand } from './agentCommands';

/** The slash-command list that rises over the composer. Presentational — key
 * handling lives in the composer's useAgentComposer hook. */
export function AgentPalette({
  matches,
  index,
  onRun,
}: {
  matches: AgentCommand[];
  index: number;
  onRun: (cmd: AgentCommand) => void;
}) {
  return (
    <div className="agent-palette">
      {matches.map((c, i) => (
        <button
          type="button"
          key={c.id}
          className={`agent-palette-row${i === index ? ' sel' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onRun(c);
          }}
        >
          <span className="agent-palette-glyph" aria-hidden>
            {c.glyph}
          </span>
          <span className="agent-palette-name">{c.trigger}</span>
          {c.args ? <span className="agent-palette-args">{c.args}</span> : <span />}
          <span className="agent-palette-desc">{c.desc}</span>
          {c.kind === 'agent' ? <span className="agent-palette-tag">agent</span> : null}
        </button>
      ))}
    </div>
  );
}
