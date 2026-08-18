import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import { frameLabel, type FlameNode, type ProfileSummary } from '../../api/client';
import type { ProfileStore } from '../../state/profile';
import { frameColor, layoutFlame, rectAt, type FlameRect } from '../../render/flamegraph';
import { fractionAt } from '../../render/timeline';

/** Internal canvas resolution; CSS stretches the width to the panel. */
const WIDTH = 960;
const ROW_HEIGHT = 20;

/**
 * The flamegraph: a call tree merging stacks that share a prefix, widths
 * proportional to sample count. Clicking a frame zooms into its subtree —
 * that frame becomes the full-width top row — and a filter change resets
 * the zoom, since the previous focus is not part of the freshly fetched
 * tree.
 */
export function FlamegraphView(props: { store: ProfileStore; summary: ProfileSummary }) {
  const [zoomed, setZoomed] = createSignal<FlameNode>();
  const [hovered, setHovered] = createSignal<FlameRect>();
  let surface!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;

  createEffect(() => {
    props.store.flamegraph();
    setZoomed(undefined);
  });

  const focus = createMemo<FlameNode | undefined>(() => zoomed() ?? props.store.flamegraph());
  const rects = createMemo(() => {
    const root = focus();
    return root ? layoutFlame(root) : [];
  });
  const rows = createMemo(() => rects().reduce((max, r) => Math.max(max, r.depth + 1), 1));

  const labelOf = (rect: FlameRect) =>
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
      const y = rect.depth * ROW_HEIGHT;
      const label = labelOf(rect);

      ctx.fillStyle = frameColor(label);
      ctx.fillRect(x, y, width, ROW_HEIGHT - 1);

      if (hovered() === rect) {
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
    const depth = Math.floor((event.clientY - bounds.top) / ROW_HEIGHT);
    return rectAt(rects(), depth, x);
  };

  return (
    <section class="view-flamegraph" aria-label="Flamegraph view">
      <Show when={props.store.flamegraph()}>
        {(root) => (
          <>
            <p class="selection-size">
              {root().samples.toLocaleString('en-US')} samples in selection
              <Show when={zoomed()}>
                {(node) => {
                  const frame = node().frame;
                  return (
                    <>
                      {' · zoomed into '}
                      <strong>{frame === null ? '' : frameLabel(props.summary.frames, frame)}</strong>
                      {' — '}
                      <button
                        type="button"
                        class="link-button"
                        onClick={() => setZoomed(undefined)}
                      >
                        reset zoom
                      </button>
                    </>
                  );
                }}
              </Show>
            </p>
            <Show
              when={root().samples > 0}
              fallback={<p class="empty">No samples in this selection.</p>}
            >
              <div
                class="flame-surface"
                data-testid="flame-surface"
                ref={surface}
                onPointerMove={(e) => setHovered(rectUnderPointer(e))}
                onPointerLeave={() => setHovered(undefined)}
                onClick={(e) => {
                  const rect = rectUnderPointer(e);
                  if (rect) setZoomed(rect.node);
                }}
              >
                <canvas ref={canvas} />
              </div>
              <p class="muted flame-hover" aria-live="polite">
                <Show when={hovered()} fallback="Hover a frame to inspect it; click to zoom in.">
                  {(rect) =>
                    `${labelOf(rect())} — ${rect().node.samples.toLocaleString('en-US')} samples (${(
                      (100 * rect().node.samples) /
                      (focus()?.samples ?? 1)
                    ).toFixed(1)}%)`
                  }
                </Show>
              </p>
            </Show>
          </>
        )}
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
