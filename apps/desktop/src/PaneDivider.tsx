import { useCallback } from 'react';
import type { DividerRect } from './layoutRects';

/**
 * A draggable branch boundary. `ratio` is measured against the branch's own box
 * (`divider.containerRect`), so nested dividers track correctly rather than
 * against the whole terminal area. The container's on-screen origin is
 * `containerOrigin` (the `.resident-terminals` box top-left in client space).
 */
export function PaneDivider({
  divider,
  containerOrigin,
  onRatio,
}: {
  divider: DividerRect;
  containerOrigin: { left: number; top: number };
  onRatio: (ratio: number) => void;
}) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const box = divider.containerRect;
      const move = (ev: PointerEvent) => {
        const ratio =
          divider.dir === 'row'
            ? (ev.clientX - containerOrigin.left - box.left) / Math.max(1, box.width)
            : (ev.clientY - containerOrigin.top - box.top) / Math.max(1, box.height);
        onRatio(ratio);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [divider.dir, divider.containerRect, containerOrigin.left, containerOrigin.top, onRatio],
  );

  return (
    <div
      className={`pane-divider pane-divider-${divider.dir}`}
      style={{
        left: divider.rect.left,
        top: divider.rect.top,
        width: divider.rect.width,
        height: divider.rect.height,
      }}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={divider.dir === 'row' ? 'vertical' : 'horizontal'}
    />
  );
}
