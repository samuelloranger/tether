import { type AgentStatus, type AgentUsage, formatCost, formatTokens, type UsageWindow } from './agentTypes';

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
    <span className="agent-gauge" title={resetHint(label, window)}>
      <span className="agent-gauge-label">{label}</span>
      <span className="agent-gauge-track">
        <span className={`agent-gauge-fill sev-${severity(pct)}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="agent-gauge-pct">{window.utilization}%</span>
    </span>
  );
}

/** Single-line stats bar atop the composer: model name, 5h/7day usage gauges,
 * and this chat's running token/cost total — all on one row. Renders nothing
 * until at least one datum is known. */
export function AgentInfoStrip({
  status,
  sessionUsage,
}: {
  status: AgentStatus | null;
  sessionUsage: AgentUsage | null;
}) {
  const model = status?.model ?? null;
  const fiveHour = status?.fiveHour ?? null;
  const sevenDay = status?.sevenDay ?? null;
  if (!model && !fiveHour && !sevenDay && !sessionUsage) return null;

  const tokens =
    sessionUsage && (sessionUsage.inputTokens || sessionUsage.outputTokens)
      ? `${formatTokens(sessionUsage.inputTokens)}↑ ${formatTokens(sessionUsage.outputTokens)}↓`
      : '';
  const cost = sessionUsage?.costUsd ? formatCost(sessionUsage.costUsd) : '';
  const total = [tokens, cost].filter(Boolean).join(' · ');

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
        {total ? (
          <span className="agent-info-total" title="This chat's tokens and cost">
            {total}
          </span>
        ) : null}
      </span>
    </div>
  );
}
