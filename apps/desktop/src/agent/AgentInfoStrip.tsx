import type { AgentStatus, UsageWindow } from './agentTypes';

function severity(pct: number): 'ok' | 'warn' | 'crit' {
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}

/** Local wall-clock time a window resets, for the tooltip. */
function resetHint(label: string, w: UsageWindow): string {
  if (!w.resetsAt) return `${label}: ${w.utilization}% used`;
  const at = new Date(w.resetsAt);
  const when = Number.isNaN(at.getTime()) ? w.resetsAt : at.toLocaleString();
  return `${label}: ${w.utilization}% used · resets ${when}`;
}

function Gauge({ label, window }: { label: string; window: UsageWindow }) {
  const pct = Math.max(0, Math.min(100, window.utilization));
  return (
    <div className="agent-gauge" title={resetHint(label, window)}>
      <span className="agent-gauge-label">{label}</span>
      <span className="agent-gauge-track">
        <span className={`agent-gauge-fill sev-${severity(pct)}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="agent-gauge-pct">{window.utilization}%</span>
    </div>
  );
}

/** Compact strip atop the chat: model name + 5h/7day usage gauges. Renders
 * nothing until at least one field is known. */
export function AgentInfoStrip({ status }: { status: AgentStatus | null }) {
  if (!status) return null;
  const { model, fiveHour, sevenDay } = status;
  if (!model && !fiveHour && !sevenDay) return null;
  return (
    <div className="agent-info-strip">
      {model ? (
        <span className="agent-info-model" title={model}>
          {model}
        </span>
      ) : null}
      <span className="agent-info-gauges">
        {fiveHour ? <Gauge label="5h" window={fiveHour} /> : null}
        {sevenDay ? <Gauge label="7d" window={sevenDay} /> : null}
      </span>
    </div>
  );
}
