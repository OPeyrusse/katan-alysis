import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import { frameLabel, type FlameNode, type ProfileSummary } from '../../api/client';
import type { ProfileStore } from '../../state/profile';
import {
  findPath,
  frameColor,
  layoutFlameWithAncestors,
  rectAt,
  type FlameRect,
} from '../../render/flamegraph';
import { fractionAt } from '../../render/timeline';

/** Internal canvas resolution; CSS stretches the width to the panel. */
const WIDTH = 960;
const ROW_HEIGHT = 20;

/**
 * The flamegraph: a call tree merging stacks that share a prefix, widths
 * proportional to sample count. Clicking a frame re-roots the view on it —
 * that frame becomes the full-width focus row, with its call path drawn
 * above as one full-width row per ancestor. The view auto-scrolls the
 * focus to the top, so ancestors stay reachable by scrolling back up and
 * clicking one makes it the new focus in turn. A filter change resets the
 * zoom entirely, since the previous focus is not part of the freshly
 * fetched tree.
 */
export function FlamegraphView(props: { store: ProfileStore; summary: ProfileSummary }) {
  const [zoomStack, setZoomStack] = createSignal<FlameNode[]>([]);
  const [hovered, setHovered] = createSignal<FlameRect>();
  let surface!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;

  createEffect(() => {
    props.store.flamegraph();
    setZoomStack([]);
  });

  const path = createMemo<FlameNode[]>(() => {
    const stack = zoomStack();
    if (stack.length > 0) return stack;
    const root = props.store.flamegraph();
    return root ? [root] : [];
  });
  const ancestors = createMemo(() => path().slice(0, -1));
  const focus = createMemo<FlameNode | undefined>(() => path().at(-1));
  const rects = createMemo(() => {
    const root = focus();
    return root ? layoutFlameWithAncestors(ancestors(), root) : [];
  });
  const rows = createMemo(() => rects().reduce((max, r) => Math.max(max, r.depth + 1), 1));

  createEffect(() => {
    if (surface) surface.scrollTop = ancestors().length * ROW_HEIGHT;
  });

  const frameLabelOf = (node: FlameNode) =>
    node.frame === null ? '' : frameLabel(props.summary.frames, node.frame);
  const labelOf = (rect: FlameRect) => frameLabelOf(rect.node);
  const focusLabel = createMemo(() => {
    const node = focus();
    return node ? frameLabelOf(node) : '';
  });

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
    const depth = Math.floor((event.clientY - bounds.top + surface.scrollTop) / ROW_HEIGHT);
    return rectAt(rects(), depth, x);
  };

  const zoomTo = (node: FlameNode) => {
    const root = props.store.flamegraph();
    const newPath = root && findPath(root, node);
    if (newPath) setZoomStack(newPath);
  };

  return (
    <section class="view-flamegraph" aria-label="Flamegraph view">
      <Show when={props.store.flamegraph()}>
        {(root) => (
          <>
            <p class="selection-size">
              {root().samples.toLocaleString('en-US')} samples in selection
              <Show when={ancestors().length > 0}>
                {' · zoomed into '}
                <strong>{focusLabel()}</strong>
                {' — '}
                <button type="button" class="link-button" onClick={() => setZoomStack([])}>
                  reset zoom
                </button>
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
                  if (rect) zoomTo(rect.node);
                }}
              >
                <canvas ref={canvas} />
              </div>
              <p class="muted flame-hover" aria-live="polite">
                <Show when={hovered()} fallback="Hover a frame to inspect it; click to zoom in.">
                  {(rect) => (
                    <>
                      {`${labelOf(rect())} — ${rect().node.samples.toLocaleString('en-US')} samples (${(
                        (100 * rect().node.samples) /
                        (focus()?.samples ?? 1)
                      ).toFixed(1)}%)`}
                      {' — '}
                      <button
                        type="button"
                        class="link-button"
                        onClick={() => {
                          const frame = rect().node.frame;
                          if (frame !== null) props.store.selectFrame(frame);
                        }}
                      >
                        view merged calls
                      </button>
                    </>
                  )}
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
