// Pure geometry of the heatmap canvas, in unit space ([0,1]² for column and
// row), so it is testable without a browser and independent of the
// rendered size.
//
// The grid always covers the whole recording (see jfr-model::HeatmapGrid),
// so column 0 sits at recording-relative nanosecond 0 wherever this module
// is used — no separate anchor needs to travel alongside it.

import type { HeatmapGrid } from '../api/client';

export interface HeatmapCell {
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

/** One cell per `(column, row)` of `grid`, positioned in unit space. */
export function layoutHeatmap(grid: HeatmapGrid): HeatmapCell[] {
  const columns = grid.columns.length;
  if (columns === 0 || grid.rows === 0) return [];
  const width = 1 / columns;
  const height = 1 / grid.rows;
  const cells: HeatmapCell[] = [];
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < grid.rows; row++) {
      cells.push({
        column,
        row,
        x: column * width,
        y: row * height,
        width,
        height,
        count: grid.columns[column][row],
      });
    }
  }
  return cells;
}

/** The `(column, row)` at a unit position, if `grid` covers it. */
export function cellAt(
  grid: Pick<HeatmapGrid, 'columns' | 'rows'>,
  x: number,
  y: number,
): { column: number; row: number } | undefined {
  const columns = grid.columns.length;
  if (columns === 0 || grid.rows === 0) return undefined;
  if (x < 0 || x >= 1 || y < 0 || y >= 1) return undefined;
  return {
    column: Math.min(columns - 1, Math.floor(x * columns)),
    row: Math.min(grid.rows - 1, Math.floor(y * grid.rows)),
  };
}

/**
 * A color for `count` relative to `maxCount`, inside the current time
 * selection: a warm orange intensity scale from near-white at zero activity
 * up to a deep orange at the tallest cell. The square-root scale keeps
 * mid-range cells visibly shaded instead of a handful of very hot cells
 * washing out the rest.
 */
export function heatmapIntensityColor(count: number, maxCount: number): string {
  const intensity = maxCount > 0 ? Math.sqrt(Math.max(0, count) / maxCount) : 0;
  const lightness = 96 - intensity * 62;
  return `hsl(28deg 85% ${lightness}%)`;
}

/**
 * A color for `count` relative to `maxCount`, outside the current time
 * selection: the same square-root intensity scale, but in a saturated blue
 * that never fades all the way to white — the analyst should still see this
 * part of the grid as context, not as blank space.
 */
export function heatmapContextColor(count: number, maxCount: number): string {
  const intensity = maxCount > 0 ? Math.sqrt(Math.max(0, count) / maxCount) : 0;
  const lightness = 88 - intensity * 55;
  return `hsl(214deg 90% ${lightness}%)`;
}

/**
 * Whether the cell at `(column, row)` falls inside `timeRangeNanos`: no
 * window, or one holding no instant, selects the whole grid (same widening
 * rule as `Filters`). Otherwise a cell is "in" when its start instant falls
 * in the window, half-open like every other time filter in the app.
 */
export function cellInSelection(
  grid: Pick<HeatmapGrid, 'column_nanos' | 'row_nanos'>,
  column: number,
  row: number,
  timeRangeNanos: [number, number] | null | undefined,
): boolean {
  if (!timeRangeNanos) return true;
  const [start, end] = timeRangeNanos;
  if (end <= start) return true;
  const cellStart = column * grid.column_nanos + row * grid.row_nanos;
  return cellStart >= start && cellStart < end;
}

/**
 * The recording-relative nanosecond window a rectangular brush over
 * columns `[c0, c1]` and rows `[r0, r1]` (inclusive, unordered) resolves
 * to: the bounding span from the start of its earliest cell to the end of
 * its latest one. Dragging across whole columns (every row) yields exactly
 * those columns' span; dragging within a single column's rows narrows to a
 * slice inside one second — the heatmap's own gesture, finer than the
 * timeline brush. `null` when the grid holds no dimension to brush.
 */
export function brushedWindowNanos(
  grid: Pick<HeatmapGrid, 'column_nanos' | 'row_nanos'>,
  c0: number,
  r0: number,
  c1: number,
  r1: number,
): [number, number] | null {
  if (grid.column_nanos <= 0 || grid.row_nanos <= 0) return null;
  const columnLow = Math.min(c0, c1);
  const columnHigh = Math.max(c0, c1);
  const rowLow = Math.min(r0, r1);
  const rowHigh = Math.max(r0, r1);
  const start = columnLow * grid.column_nanos + rowLow * grid.row_nanos;
  const end = columnHigh * grid.column_nanos + (rowHigh + 1) * grid.row_nanos;
  return [start, end];
}
