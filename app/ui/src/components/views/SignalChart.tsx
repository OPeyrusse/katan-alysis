import { Show, createEffect } from 'solid-js';
import type { GcPause, TimePoint } from '../../api/client';
import { pauseBars, seriesPath, type UnitPoint } from '../../render/charts';
import { brushedRange, fractionAt } from '../../render/timeline';
import { prepareCanvas, type Size } from '../../render/canvas';
import { createElementSize } from '../elementSize';

/** Chart size assumed while it cannot be measured; CSS sizes the chart. */
const FALLBACK_SIZE = { width: 600, height: 90 };

export interface Series {
  label: string;
  points: TimePoint[];
  color: string;
  dashed?: boolean;
}

export interface ChartInteraction {
  cursor: number | undefined;
  onCursor: (fraction: number | undefined) => void;
  /** Called when a drag selects a period, in relative nanoseconds. */
  onBrush: (range: [number, number]) => void;
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  size: Size,
  series: Series[],
  paths: UnitPoint[][],
) {
  series.forEach((s, i) => {
    const path = paths[i];
    if (path.length === 0) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(s.dashed ? [4, 3] : []);
    ctx.beginPath();
    path.forEach((p, j) => {
      const x = p.x * size.width;
      const y = (1 - p.y) * size.height;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  ctx.setLineDash([]);
}

/**
 * One overview chart: line series (or GC pause bars) over the whole
 * recording, a shared hover cursor, and a brush that hands the dragged
 * period to the caller ("analyze this period").
 */
export function SignalChart(props: {
  title: string;
  unitLabel: string;
  /** Upper bound of the y axis, in signal units. */
  ceiling: number;
  series?: Series[];
  pauses?: GcPause[];
  durationNanos: number;
  interaction: ChartInteraction;
  /** Shown when every series is empty. */
  emptyText?: string;
}) {
  // Drawn at the chart's own size rather than stretched to it by CSS,
  // which would soften every line.
  const [chartSize, trackChartSize] = createElementSize(FALLBACK_SIZE);
  let canvas!: HTMLCanvasElement;
  let dragFrom: number | undefined;

  const hasData = () =>
    (props.series ?? []).some((s) => s.points.length > 0) ||
    (props.pauses ?? []).length > 0;

  createEffect(() => {
    if (!canvas) return;
    const size = chartSize();
    const ctx = prepareCanvas(canvas, size);
    if (!ctx) return;
    if (props.series) {
      const paths = props.series.map((s) =>
        seriesPath(s.points, props.durationNanos, props.ceiling),
      );
      drawLines(ctx, size, props.series, paths);
    }
    if (props.pauses) {
      ctx.fillStyle = '#c47a4a';
      for (const bar of pauseBars(props.pauses, props.durationNanos)) {
        const h = Math.max(2, bar.height * size.height);
        ctx.fillRect(bar.x * size.width - 1, size.height - h, 2, h);
      }
    }
  });

  // Read off the canvas's own box: it is what the series were drawn into.
  const fractionOf = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return fractionAt(event.clientX, rect.left, rect.width);
  };

  return (
    <section class="signal-chart" aria-label={props.title}>
      <header>
        <span class="chart-title">{props.title}</span>
        <span class="chart-legend">
          {(props.series ?? []).map((s) => `— ${s.label}`).join('  ')}
          <Show when={props.pauses}> | = one pause (height = duration)</Show>
        </span>
        <span class="chart-ceiling">
          {props.unitLabel}, 0–{props.ceiling === 0 ? '?' : formatCeiling(props.ceiling, props.unitLabel)}
        </span>
      </header>
      <Show
        when={hasData()}
        fallback={<p class="empty">{props.emptyText ?? 'Not in this recording.'}</p>}
      >
        <div
          class="chart-surface"
          ref={trackChartSize}
          data-testid={`chart-${props.title}`}
          onPointerDown={(e) => {
            dragFrom = fractionOf(e);
          }}
          onPointerMove={(e) => props.interaction.onCursor(fractionOf(e))}
          onPointerLeave={() => props.interaction.onCursor(undefined)}
          onPointerUp={(e) => {
            const from = dragFrom;
            dragFrom = undefined;
            if (from === undefined) return;
            const range = brushedRange(from, fractionOf(e), props.durationNanos);
            if (range) props.interaction.onBrush(range);
          }}
        >
          <canvas ref={canvas} />
          <Show when={props.interaction.cursor !== undefined}>
            <div
              class="chart-cursor"
              style={{ left: `${100 * (props.interaction.cursor ?? 0)}%` }}
            />
          </Show>
        </div>
      </Show>
    </section>
  );
}

function formatCeiling(ceiling: number, unitLabel: string): string {
  if (unitLabel === '%') return `${Math.round(ceiling * 100)} %`;
  if (unitLabel === 'ms') return `${Math.round(ceiling / 1_000_000)} ms`;
  return `${(ceiling / (1024 * 1024)).toFixed(0)} MB`;
}
