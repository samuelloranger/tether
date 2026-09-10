import { useState } from 'react';
import { MODEL_ALIASES } from './agentCommands';

/** `/model` picker: the static aliases (current one checked) plus a free-text
 * row for any full model ID. Picking sends `agent.model` and closes. */
export function AgentModelPicker({
  current,
  onPick,
  onClose,
}: {
  current: string | null | undefined;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState('');
  const submitCustom = () => {
    const name = custom.trim();
    if (name) onPick(name);
  };

  return (
    <div className="agent-folder-backdrop" onPointerDown={onClose}>
      <div className="agent-model-picker" onPointerDown={(e) => e.stopPropagation()}>
        <div className="agent-model-title">Model for this chat</div>
        {MODEL_ALIASES.map((m) => {
          const isCurrent = current === m.name;
          return (
            <button
              type="button"
              key={m.name}
              className={`agent-model-row${isCurrent ? ' sel' : ''}`}
              onClick={() => onPick(m.name)}
            >
              <span className="agent-model-check" aria-hidden>
                {isCurrent ? '✓' : ''}
              </span>
              <span className="agent-model-name">{m.name}</span>
              <span className="agent-model-desc">{m.desc}</span>
            </button>
          );
        })}
        <div className="agent-model-custom">
          <input
            className="agent-folder-input"
            placeholder="type a model ID…"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCustom();
              else if (e.key === 'Escape') onClose();
            }}
          />
        </div>
      </div>
    </div>
  );
}
