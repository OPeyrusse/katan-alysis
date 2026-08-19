import { describe, expect, it } from 'vitest';
import type { HeatmapGrid } from '../api/client';
import { brushedWindowNanos, cellAt, heatmapColor, layoutHeatmap } from './heatmap';

function grid(columns: number[][], overrides: Partial<HeatmapGrid> = {}): HeatmapGrid {
  return {
    column_nanos: 1_000_000_000,
    row_nanos: 20_000_000,
    rows: columns[0]?.length ?? 0,
    columns,
    max_count: Math.max(0, ...columns.flat()),
    ...overrides,
  };
}

describe('layoutHeatmap', () => {
  it('lays out one cell per column and row, in unit space', () => {
    const cells = layoutHeatmap(grid([[1, 2]]));
    expect(cells).toEqual([
      { column: 0, row: 0, x: 0, y: 0, width: 1, height: 0.5, count: 1 },
      { column: 0, row: 1, x: 0, y: 0.5, width: 1, height: 0.5, count: 2 },
    ]);
  });

  it('spans two columns at half width each', () => {
    const cells = layoutHeatmap(grid([[1], [2]]));
    expect(cells.map((c) => c.x)).toEqual([0, 0.5]);
    expect(cells.every((c) => c.width === 0.5)).toBe(true);
  });

  it('is empty when the grid holds no column', () => {
    expect(layoutHeatmap(grid([]))).toEqual([]);
  });
});

describe('cellAt', () => {
  const g = grid([
    [1, 2],
    [3, 4],
  ]);

  it('finds the cell covering a unit position', () => {
    expect(cellAt(g, 0.2, 0.2)).toEqual({ column: 0, row: 0 });
    expect(cellAt(g, 0.6, 0.6)).toEqual({ column: 1, row: 1 });
  });

  it('treats a boundary as belonging to the next cell', () => {
    expect(cellAt(g, 0.5, 0)).toEqual({ column: 1, row: 0 });
  });

  it('clamps the far edge instead of missing it', () => {
    expect(cellAt(g, 0.999999, 0.999999)).toEqual({ column: 1, row: 1 });
  });

  it('misses positions outside [0, 1)', () => {
    expect(cellAt(g, -0.1, 0)).toBeUndefined();
    expect(cellAt(g, 0, 1)).toBeUndefined();
  });

  it('misses everything on an empty grid', () => {
    expect(cellAt(grid([]), 0, 0)).toBeUndefined();
  });
});

describe('heatmapColor', () => {
  it('is transparent for an empty cell', () => {
    expect(heatmapColor(0, 10)).toBe('transparent');
  });

  it('is transparent when the grid holds no sample at all', () => {
    expect(heatmapColor(0, 0)).toBe('transparent');
  });

  it('is deterministic for the same ratio', () => {
    expect(heatmapColor(5, 10)).toBe(heatmapColor(5, 10));
  });

  it('gets darker as the count approaches the max', () => {
    const lightnessOf = (color: string) => Number(color.match(/(\d+)%\)$/)?.[1]);
    expect(lightnessOf(heatmapColor(10, 10))).toBeLessThan(lightnessOf(heatmapColor(1, 10)));
  });
});

describe('brushedWindowNanos', () => {
  // Three columns of five rows each, so a single-column brush (below) has
  // room to pick a row strictly inside the column.
  const g = grid([
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ]);

  it('spans whole columns when every row is covered', () => {
    expect(brushedWindowNanos(g, 0, 0, 1, 4)).toEqual([0, 1_100_000_000]);
  });

  it('narrows to a slice within a single column', () => {
    // Column 2, rows 3..3 only: [2s + 60ms, 2s + 80ms).
    expect(brushedWindowNanos(g, 2, 3, 2, 3)).toEqual([2_060_000_000, 2_080_000_000]);
  });

  it('is order-independent between the two corners', () => {
    expect(brushedWindowNanos(g, 1, 1, 0, 0)).toEqual(brushedWindowNanos(g, 0, 0, 1, 1));
  });

  it('is null without a real column or row width', () => {
    expect(brushedWindowNanos({ column_nanos: 0, row_nanos: 20 }, 0, 0, 0, 0)).toBeNull();
  });
});
