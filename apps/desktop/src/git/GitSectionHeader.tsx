export function GitSectionHeader({
  label,
  count,
  actions,
}: {
  label: string;
  count: number;
  actions?: React.ReactNode;
}) {
  return (
    <div className="git-section-header">
      <span>
        {label} ({count})
      </span>
      {actions ? <div className="git-section-actions">{actions}</div> : null}
    </div>
  );
}

export function GitTabBar({
  tab,
  onChange,
}: {
  tab: 'changes' | 'history';
  onChange: (tab: 'changes' | 'history') => void;
}) {
  return (
    <div className="git-tab-bar" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'changes'}
        className={tab === 'changes' ? 'active' : 'secondary'}
        onClick={() => onChange('changes')}
      >
        Changes
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'history'}
        className={tab === 'history' ? 'active' : 'secondary'}
        onClick={() => onChange('history')}
      >
        History
      </button>
    </div>
  );
}
