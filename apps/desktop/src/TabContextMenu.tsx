import type { PaneDir, PaneSide } from './paneTree';
import { MOD_LABEL } from './platform';

export function TabContextMenu({
  x,
  y,
  onSplit,
  onClose,
}: {
  x: number;
  y: number;
  onSplit: (dir: PaneDir, side: PaneSide) => void;
  onClose: () => void;
}) {
  const item = (label: string, dir: PaneDir, side: PaneSide, shortcut?: string) => (
    <button
      type="button"
      className="tab-menu-item"
      onClick={() => {
        onSplit(dir, side);
        onClose();
      }}
    >
      <span>{label}</span>
      {shortcut ? <span className="tab-menu-key">{shortcut}</span> : null}
    </button>
  );
  return (
    <>
      <button
        type="button"
        className="tab-menu-scrim"
        aria-label="Close menu"
        onClick={onClose}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="tab-menu" style={{ left: x, top: y }}>
        {item('Split right', 'row', 'b', `${MOD_LABEL}D`)}
        {item('Split left', 'row', 'a')}
        {item('Split up', 'col', 'a')}
        {item('Split down', 'col', 'b', `${MOD_LABEL}E`)}
      </div>
    </>
  );
}
