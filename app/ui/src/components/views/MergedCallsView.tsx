import { Show, createEffect, createMemo } from 'solid-js';
import { frameLabel, type ProfileSummary } from '../../api/client';
import type { ProfileStore } from '../../state/profile';
import { cellAt, frameColor, rectAt } from '../../render/flamegraph';
import { layoutMergedCalls, type MergedCallRect } from '../../render/mergedCalls';
import { prepareCanvas } from '../../render/canvas';
import { createElementSize } from '../elementSize';

/** Height of a call row, in CSS pixels. */
const ROW_HEIGHT = 20;
/** Canvas size assumed while the panel cannot be measured. */
const FALLBACK_SIZE = { width: 960, height: ROW_HEIGHT };

/**
 * Callers and callees merged around one focused method: the analyst
 * reaches this view by selecting a method from top-methods or the
 * flamegraph. Callers grow upward from the focus row, callees downward,
 * so both read outward from the method that ties them together. Clicking
 * another row refocuses the view on it, narrowing further one step at a
 * time.
 */
export function MergedCallsView(props: { store: ProfileStore; summary: ProfileSummary }) {
  // Drawn at the panel's own width rather than stretched to it by CSS, so
  // rows land where the pointer expects them and the text stays crisp.
  const [surfaceSize, trackSurface] = createElementSize(FALLBACK_SIZE);
  let canvas!: HTMLCanvasElement;

  const rects = createMemo(() => {
    const tree = props.store.mergedCalls();
    return tree ? layoutMergedCalls(tree) : [];
  });
  const minDepth = createMemo(() => rects().reduce((min, r) => Math.min(min, r.depth), 0));
  const maxDepth = createMemo(() => rects().reduce((max, r) => Math.max(max, r.depth), 0));
  const rows = createMemo(() => maxDepth() - minDepth() + 1);

  const labelOf = (rect: MergedCallRect) =>
    rect.node.frame === null ? '' : frameLabel(props.summary.frames, rect.node.frame);

  createEffect(() => {
    if (!canvas) return;
    const width = surfaceSize().width;
    const ctx = prepareCanvas(canvas, { width, height: rows() * ROW_HEIGHT });
    if (!ctx) return;
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';

    for (const rect of rects()) {
      const x = rect.x * width;
      const boxWidth = Math.max(0.5, rect.width * width);
      const y = (rect.depth - minDepth()) * ROW_HEIGHT;
      const label = labelOf(rect);

      ctx.fillStyle = frameColor(label);
      ctx.fillRect(x, y, boxWidth, ROW_HEIGHT - 1);

      if (rect.depth === 0) {
        ctx.strokeStyle = 'rgb(0 0 0 / 60%)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, boxWidth - 1, ROW_HEIGHT - 2);
      }

      if (boxWidth > 20) {
        ctx.fillStyle = 'rgb(0 0 0 / 85%)';
        ctx.fillText(clip(ctx, label, boxWidth - 6), x + 3, y + ROW_HEIGHT / 2);
      }
    }
  });

  // Resolved against the canvas's own box: rows are counted from the top
  // of what is drawn, and callers start at a negative depth.
  const rectUnderPointer = (event: { clientX: number; clientY: number }) => {
    const cell = cellAt(event.clientX, event.clientY, canvas.getBoundingClientRect(), rows());
    return rectAt(rects(), cell.depth + minDepth(), cell.x);
  };

  return (
    <section class="view-merged-calls" aria-label="Merged calls view">
      <Show
        when={props.store.selectedFrame() !== undefined}
        fallback={
          <p class="empty">
            Select a method from Top methods or the Flamegraph to see its merged callers and
            callees.
          </p>
        }
      >
        <Show when={props.store.mergedCalls()}>
          {(tree) => (
            <>
              <p class="selection-size">
                Focused on <strong>{frameLabel(props.summary.frames, tree().focus)}</strong> —{' '}
                {tree().callers.samples.toLocaleString('en-US')} samples in selection
              </p>
              <Show
                when={tree().callers.samples > 0}
                fallback={<p class="empty">No samples in this selection.</p>}
              >
                <div
                  class="merged-calls-surface"
                  data-testid="merged-calls-surface"
                  ref={trackSurface}
                  onClick={(e) => {
                    const rect = rectUnderPointer(e);
                    if (rect && rect.node.frame !== null && rect.depth !== 0) {
                      props.store.selectFrame(rect.node.frame);
                    }
                  }}
                >
                  <canvas ref={canvas} />
                </div>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </section>
  );
}

/** Truncates `label` with an ellipsis so it fits `maxWidth` canvas pixels. */
function clip(ctx: CanvasRenderingContext2D, label: string, maxWidth: number): string {
  if (ctx.measureText(label).width <= maxWidth) return label;
  let text = label;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) {
    text = text.slice(0, -1);
  }
  return `${text}…`;
}
