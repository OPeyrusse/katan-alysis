import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { ProfileSummary } from '../../api/client';
import type { ProfileStore } from '../../state/profile';
import { brushedWindowNanos, cellAt, heatmapColor, layoutHeatmap } from '../../render/heatmap';
import { fractionAt } from '../../render/timeline';
import { formatClock } from '../../format';

/** Internal canvas resolution; CSS stretches it to the panel. */
const WIDTH = 720;
const HEIGHT = 300;

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
  let surface!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [drag, setDrag] = createSignal<{ start: Cell; current: Cell }>();
  const [hovered, setHovered] = createSignal<Cell>();

  const grid = () => props.store.heatmap();
  const cells = createMemo(() => {
    const g = grid();
    return g ? layoutHeatmap(g) : [];
  });
  const total = createMemo(() => cells().reduce((sum, c) => sum + c.count, 0));

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
    const ctx = canvas?.getContext('2d');
    const g = grid();
    if (!ctx || !g) return;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    for (const cell of cells()) {
      ctx.fillStyle = heatmapColor(cell.count, g.max_count);
      ctx.fillRect(
        cell.x * WIDTH,
        cell.y * HEIGHT,
        Math.max(1, cell.width * WIDTH),
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
      const x = (c0 / columns) * WIDTH;
      const width = ((c1 - c0 + 1) / columns) * WIDTH;
      const y = (r0 / g.rows) * HEIGHT;
      const height = ((r1 - r0 + 1) / g.rows) * HEIGHT;
      ctx.strokeStyle = 'rgb(0 0 0 / 70%)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
    }
  });

  const cellUnderPointer = (event: { clientX: number; clientY: number }): Cell | undefined => {
    const bounds = surface.getBoundingClientRect();
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
        <Show when={total() > 0} fallback={<p class="empty">No samples in this selection.</p>}>
          <div
            class="heatmap-surface"
            data-testid="heatmap-surface"
            ref={surface}
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
