import { Show, createEffect, createMemo } from 'solid-js';
import { frameLabel, type ProfileSummary } from '../../api/client';
import type { ProfileStore } from '../../state/profile';
import { frameColor, rectAt } from '../../render/flamegraph';
import { layoutMergedCalls, type MergedCallRect } from '../../render/mergedCalls';
import { fractionAt } from '../../render/timeline';

/** Internal canvas resolution; CSS stretches the width to the panel. */
const WIDTH = 960;
const ROW_HEIGHT = 20;

/**
 * Callers and callees merged around one focused method: the analyst
 * reaches this view by selecting a method from top-methods or the
 * flamegraph. Callers grow upward from the focus row, callees downward,
 * so both read outward from the method that ties them together. Clicking
 * another row refocuses the view on it, narrowing further one step at a
 * time.
 */
export function MergedCallsView(props: { store: ProfileStore; summary: ProfileSummary }) {
  let surface!: HTMLDivElement;
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
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const height = rows() * ROW_HEIGHT;
    canvas.width = WIDTH;
    canvas.height = height;
    ctx.clearRect(0, 0, WIDTH, height);
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';

    for (const rect of rects()) {
      const x = rect.x * WIDTH;
      const width = Math.max(0.5, rect.width * WIDTH);
      const y = (rect.depth - minDepth()) * ROW_HEIGHT;
      const label = labelOf(rect);

      ctx.fillStyle = frameColor(label);
      ctx.fillRect(x, y, width, ROW_HEIGHT - 1);

      if (rect.depth === 0) {
        ctx.strokeStyle = 'rgb(0 0 0 / 60%)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, width - 1, ROW_HEIGHT - 2);
      }

      if (width > 20) {
        ctx.fillStyle = 'rgb(0 0 0 / 85%)';
        ctx.fillText(clip(ctx, label, width - 6), x + 3, y + ROW_HEIGHT / 2);
      }
    }
  });

  const rectUnderPointer = (event: { clientX: number; clientY: number }) => {
    const bounds = surface.getBoundingClientRect();
    const x = fractionAt(event.clientX, bounds.left, bounds.width);
    const depth = Math.floor((event.clientY - bounds.top) / ROW_HEIGHT) + minDepth();
    return rectAt(rects(), depth, x);
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
                  ref={surface}
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
