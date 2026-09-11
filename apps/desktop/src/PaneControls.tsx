import type { PaneDir, PaneSide } from './paneTree';
import { MOD_LABEL } from './platform';

const svgProps = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  'aria-hidden': true,
} as const;

// The button `title` is the accessible name; the glyph is decorative. `aria-hidden`
// is repeated on each element because the lint rule can't see it through the spread.

/** Hover controls on the focused pane: split into a side-by-side (row) or a
 *  stacked (col) pair, or close. Icons mirror the resulting layout — a vertical
 *  divider for side-by-side, a horizontal one for stacked. */
export function PaneControls({
  paneId,
  onSplit,
  onClose,
}: {
  paneId: string;
  onSplit: (paneId: string, dir: PaneDir, side: PaneSide) => void;
  onClose: (paneId: string) => void;
}) {
  return (
    <div className="pane-controls">
      <button type="button" title={`Split right (${MOD_LABEL}D)`} onClick={() => onSplit(paneId, 'row', 'b')}>
        <svg {...svgProps} aria-hidden>
          <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" />
          <line x1="8" y1="2.75" x2="8" y2="13.25" />
        </svg>
      </button>
      <button type="button" title={`Split down (${MOD_LABEL}E)`} onClick={() => onSplit(paneId, 'col', 'b')}>
        <svg {...svgProps} aria-hidden>
          <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" />
          <line x1="2.25" y1="8" x2="13.75" y2="8" />
        </svg>
      </button>
      <button type="button" title={`Close pane (${MOD_LABEL}W)`} onClick={() => onClose(paneId)}>
        <svg {...svgProps} aria-hidden>
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      </button>
    </div>
  );
}
