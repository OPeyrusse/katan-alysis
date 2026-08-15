import { Show, createEffect, createSignal } from 'solid-js';
import type { ProfileSummary } from '../api/client';
import type { ProfileStore } from '../state/profile';
import {
  brushedRange,
  densityBars,
  fractionAt,
  rangeFractions,
} from '../render/timeline';
import { formatClock } from '../format';

/** Internal canvas resolution; CSS stretches it to the strip's width. */
const STRIP_WIDTH = 600;
const STRIP_HEIGHT = 40;

/**
 * The whole-recording density strip with the time-window brush. Dragging
 * selects a window; a click that selects no instant clears it — backing out
 * of a selection, not narrowing to nothing.
 */
export function TimelineBrush(props: { store: ProfileStore; summary: ProfileSummary }) {
  let strip!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [drag, setDrag] = createSignal<{ from: number; to: number }>();

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
    const ctx = canvas?.getContext('2d');
    if (!density || !ctx) return;
    ctx.clearRect(0, 0, STRIP_WIDTH, STRIP_HEIGHT);
    ctx.fillStyle = '#7a9cc4';
    for (const bar of densityBars(density.counts)) {
      const h = bar.height * STRIP_HEIGHT;
      ctx.fillRect(bar.x * STRIP_WIDTH, STRIP_HEIGHT - h, bar.width * STRIP_WIDTH, h);
    }
  });

  const fractionOf = (event: PointerEvent) => {
    const rect = strip.getBoundingClientRect();
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
        ref={strip}
        data-testid="timeline-strip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvas} width={STRIP_WIDTH} height={STRIP_HEIGHT} />
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
