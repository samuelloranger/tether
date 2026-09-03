import type { PaneDir, PaneSide } from './paneTree';

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
  const item = (label: string, dir: PaneDir, side: PaneSide) => (
    <button
      type="button"
      className="tab-menu-item"
      onClick={() => {
        onSplit(dir, side);
        onClose();
      }}
    >
      {label}
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
        {item('Split right', 'row', 'b')}
        {item('Split left', 'row', 'a')}
        {item('Split up', 'col', 'a')}
        {item('Split down', 'col', 'b')}
      </div>
    </>
  );
}
