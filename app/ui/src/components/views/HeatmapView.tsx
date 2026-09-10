import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { ProfileSummary } from '../../api/client';
import type { ProfileStore } from '../../state/profile';
import {
  brushedWindowNanos,
  cellAt,
  cellInSelection,
  heatmapContextColor,
  heatmapIntensityColor,
  layoutHeatmap,
} from '../../render/heatmap';
import { fractionAt } from '../../render/timeline';
import { prepareCanvas } from '../../render/canvas';
import { createElementSize } from '../elementSize';
import { formatClock } from '../../format';

/** Height of the heatmap, in CSS pixels; the width follows the panel. */
const HEIGHT = 300;
/** Canvas size assumed while the panel cannot be measured. */
const FALLBACK_SIZE = { width: 720, height: HEIGHT };

interface Cell {
  column: number;
  row: number;
}

/**
 * The FlameScope-style heatmap: sample density over the whole recording,
 * columns of one second split into 20ms rows so a periodic pattern lines
 * up down the columns. Dragging a rectangle sets the time filter to the
 * span it bounds — every row of a column-only drag, or a slice inside one
 * second when the drag stays within a single column.
 */
export function HeatmapView(props: { store: ProfileStore; summary: ProfileSummary }) {
  // Drawn at the panel's own width rather than stretched to it by CSS,
  // which would soften every cell edge.
  const [surfaceSize, trackSurface] = createElementSize(FALLBACK_SIZE);
  let surface!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;

  const trackWidth = (element: HTMLDivElement) => {
    surface = element;
    trackSurface(element);
  };
  const [drag, setDrag] = createSignal<{ start: Cell; current: Cell }>();
  const [hovered, setHovered] = createSignal<Cell>();

  const grid = () => props.store.heatmap();
  const cells = createMemo(() => {
    const g = grid();
    return g ? layoutHeatmap(g) : [];
  });
  const total = createMemo(() => cells().reduce((sum, c) => sum + c.count, 0));
  const contextTotal = createMemo(() => {
    const g = grid();
    return g ? g.context_columns.flat().reduce((sum, c) => sum + c, 0) : 0;
  });

  const countAt = (cell: Cell | undefined) => {
    const g = grid();
    if (!g || !cell) return undefined;
    return g.columns[cell.column]?.[cell.row];
  };

  const timeAt = (cell: Cell) => {
    const g = grid();
    if (!g) return 0;
    return cell.column * g.column_nanos + cell.row * g.row_nanos;
  };

  createEffect(() => {
    const g = grid();
    if (!canvas || !g) return;
    const width = surfaceSize().width;
    const ctx = prepareCanvas(canvas, { width, height: HEIGHT });
    if (!ctx) return;
    const timeRangeNanos = props.store.filters().time_range_nanos;
    for (const cell of cells()) {
      ctx.fillStyle = cellInSelection(g, cell.column, cell.row, timeRangeNanos)
        ? heatmapIntensityColor(cell.count, g.max_count)
        : heatmapContextColor(g.context_columns[cell.column]?.[cell.row] ?? 0, g.context_max_count);
      ctx.fillRect(
        cell.x * width,
        cell.y * HEIGHT,
        Math.max(1, cell.width * width),
        Math.max(1, cell.height * HEIGHT),
      );
    }

    const d = drag();
    if (d) {
      const c0 = Math.min(d.start.column, d.current.column);
      const c1 = Math.max(d.start.column, d.current.column);
      const r0 = Math.min(d.start.row, d.current.row);
      const r1 = Math.max(d.start.row, d.current.row);
      const columns = g.columns.length;
      const x = (c0 / columns) * width;
      const boxWidth = ((c1 - c0 + 1) / columns) * width;
      const y = (r0 / g.rows) * HEIGHT;
      const boxHeight = ((r1 - r0 + 1) / g.rows) * HEIGHT;
      ctx.strokeStyle = 'rgb(0 0 0 / 70%)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, boxWidth - 1), Math.max(0, boxHeight - 1));
    }
  });

  // Resolved against the canvas's own box, which no longer necessarily
  // fills the surface once the canvas is not stretched to it.
  const cellUnderPointer = (event: { clientX: number; clientY: number }): Cell | undefined => {
    const bounds = canvas.getBoundingClientRect();
    const x = fractionAt(event.clientX, bounds.left, bounds.width);
    const y = fractionAt(event.clientY, bounds.top, bounds.height);
    const g = grid();
    return g ? cellAt(g, x, y) : undefined;
  };

  const onPointerDown = (event: PointerEvent) => {
    const cell = cellUnderPointer(event);
    if (!cell) return;
    if (event.pointerId != null) surface.setPointerCapture?.(event.pointerId);
    setDrag({ start: cell, current: cell });
  };

  const onPointerMove = (event: PointerEvent) => {
    const cell = cellUnderPointer(event);
    setHovered(cell);
    const d = drag();
    if (d && cell) setDrag({ start: d.start, current: cell });
  };

  const onPointerUp = () => {
    const d = drag();
    setDrag(undefined);
    const g = grid();
    if (!d || !g) return;
    const window = brushedWindowNanos(g, d.start.column, d.start.row, d.current.column, d.current.row);
    if (!window) return;
    props.store.setFilters({ ...props.store.filters(), time_range_nanos: window });
  };

  return (
    <section class="view-heatmap" aria-label="Heatmap view">
      <Show when={grid()}>
        <p class="selection-size">{total().toLocaleString('en-US')} samples in selection</p>
        <Show
          when={contextTotal() > 0}
          fallback={<p class="empty">No samples in this recording.</p>}
        >
          <div
            class="heatmap-surface"
            data-testid="heatmap-surface"
            ref={trackWidth}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHovered(undefined)}
            onPointerUp={onPointerUp}
          >
            <canvas ref={canvas} />
          </div>
          <p class="muted heatmap-hover" aria-live="polite">
            <Show
              when={hovered()}
              fallback="Drag to select a time window; drag within one column for a slice inside a second."
            >
              {(cell) =>
                `${formatClock(timeAt(cell()))} — ${(countAt(cell()) ?? 0).toLocaleString('en-US')} samples`
              }
            </Show>
          </p>
        </Show>
      </Show>
    </section>
  );
}
