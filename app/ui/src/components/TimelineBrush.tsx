import { Show, createEffect, createSignal } from 'solid-js';
import type { ProfileSummary } from '../api/client';
import type { ProfileStore } from '../state/profile';
import {
  brushedRange,
  densityBars,
  fractionAt,
  rangeFractions,
} from '../render/timeline';
import { prepareCanvas } from '../render/canvas';
import { createElementSize } from './elementSize';
import { formatClock } from '../format';

/** Strip size assumed while it cannot be measured; CSS sizes the strip. */
const FALLBACK_SIZE = { width: 600, height: 40 };

/**
 * The whole-recording density strip with the time-window brush. Dragging
 * selects a window; a click that selects no instant clears it — backing out
 * of a selection, not narrowing to nothing.
 */
export function TimelineBrush(props: { store: ProfileStore; summary: ProfileSummary }) {
  // Drawn at the strip's own size rather than stretched to it by CSS,
  // which would blur the density bars.
  const [stripSize, trackStripSize] = createElementSize(FALLBACK_SIZE);
  let strip!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [drag, setDrag] = createSignal<{ from: number; to: number }>();

  const trackStrip = (element: HTMLDivElement) => {
    strip = element;
    trackStripSize(element);
  };

  const duration = () => props.summary.duration_nanos;
  const range = () => props.store.filters().time_range_nanos;

  // While dragging, preview the gesture; otherwise show the active window.
  const shown = () => {
    const d = drag();
    if (d) return rangeFractions(brushedRange(d.from, d.to, duration()), duration());
    return rangeFractions(range(), duration());
  };

  createEffect(() => {
    const density = props.store.density();
    if (!density || !canvas) return;
    const { width, height } = stripSize();
    const ctx = prepareCanvas(canvas, { width, height });
    if (!ctx) return;
    ctx.fillStyle = '#7a9cc4';
    for (const bar of densityBars(density.counts)) {
      const h = bar.height * height;
      ctx.fillRect(bar.x * width, height - h, bar.width * width, h);
    }
  });

  // Read off the canvas's own box: it is what the bars were drawn into.
  const fractionOf = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return fractionAt(event.clientX, rect.left, rect.width);
  };

  const onPointerDown = (event: PointerEvent) => {
    // pointerId is undefined when the event is a synthesized MouseEvent
    // (jsdom); capture is a nicety, not a requirement.
    if (event.pointerId != null) strip.setPointerCapture?.(event.pointerId);
    const f = fractionOf(event);
    setDrag({ from: f, to: f });
  };

  const onPointerMove = (event: PointerEvent) => {
    const d = drag();
    if (d) setDrag({ from: d.from, to: fractionOf(event) });
  };

  const onPointerUp = () => {
    const d = drag();
    if (!d) return;
    setDrag(undefined);
    const brushed = brushedRange(d.from, d.to, duration());
    props.store.setFilters({
      ...props.store.filters(),
      time_range_nanos: brushed ?? undefined,
    });
  };

  const label = () => {
    const r = range();
    return r
      ? `${formatClock(r[0])} → ${formatClock(r[1])}`
      : 'whole recording';
  };

  return (
    <div class="timeline" aria-label="Time period">
      <header class="timeline-header">
        <span>
          Period: {label()} (of {formatClock(duration())})
        </span>
        <Show when={range()}>
          <button
            onClick={() =>
              props.store.setFilters({
                ...props.store.filters(),
                time_range_nanos: undefined,
              })
            }
          >
            Reset
          </button>
        </Show>
      </header>
      <div
        class="timeline-strip"
        ref={trackStrip}
        data-testid="timeline-strip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvas} />
        <Show when={shown()}>
          {(fractions) => (
            <div
              class="timeline-window"
              data-testid="timeline-window"
              style={{
                left: `${100 * fractions().left}%`,
                width: `${100 * fractions().width}%`,
              }}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
