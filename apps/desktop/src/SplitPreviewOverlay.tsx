import type { DropIntent } from './dropZone';
import type { Rect } from './layoutRects';

/** Translucent ghost of where a dropped session will land inside `rect`. */
export function SplitPreviewOverlay({ rect, intent }: { rect: Rect; intent: DropIntent }) {
  const ghost = ghostRect(rect, intent);
  return <div className="split-preview" style={{ position: 'absolute', ...ghost }} />;
}

function ghostRect(rect: Rect, intent: DropIntent): Rect {
  if (intent.kind === 'replace') return rect;
  if (intent.dir === 'row') {
    const half = rect.width / 2;
    const left = intent.side === 'a' ? rect.left : rect.left + half;
    return { left, top: rect.top, width: half, height: rect.height };
  }
  const half = rect.height / 2;
  const top = intent.side === 'a' ? rect.top : rect.top + half;
  return { left: rect.left, top, width: rect.width, height: half };
}
