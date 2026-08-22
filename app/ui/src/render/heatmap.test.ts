import { describe, expect, it } from 'vitest';
import type { HeatmapGrid } from '../api/client';
import {
  brushedWindowNanos,
  cellAt,
  cellInSelection,
  heatmapContextColor,
  heatmapIntensityColor,
  layoutHeatmap,
} from './heatmap';

function grid(columns: number[][], overrides: Partial<HeatmapGrid> = {}): HeatmapGrid {
  return {
    column_nanos: 1_000_000_000,
    row_nanos: 20_000_000,
    rows: columns[0]?.length ?? 0,
    columns,
    max_count: Math.max(0, ...columns.flat()),
    context_columns: columns,
    context_max_count: Math.max(0, ...columns.flat()),
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

describe('heatmapIntensityColor', () => {
  it('is near-white for an empty cell', () => {
    const lightnessOf = (color: string) => Number(color.match(/(\d+)%\)$/)?.[1]);
    expect(lightnessOf(heatmapIntensityColor(0, 10))).toBeGreaterThan(90);
  });

  it('is near-white when the grid holds no sample at all', () => {
    const lightnessOf = (color: string) => Number(color.match(/(\d+)%\)$/)?.[1]);
    expect(lightnessOf(heatmapIntensityColor(0, 0))).toBeGreaterThan(90);
  });

  it('is deterministic for the same ratio', () => {
    expect(heatmapIntensityColor(5, 10)).toBe(heatmapIntensityColor(5, 10));
  });

  it('gets darker as the count approaches the max', () => {
    const lightnessOf = (color: string) => Number(color.match(/(\d+)%\)$/)?.[1]);
    expect(lightnessOf(heatmapIntensityColor(10, 10))).toBeLessThan(
      lightnessOf(heatmapIntensityColor(1, 10)),
    );
  });

  it('uses an orange hue', () => {
    expect(heatmapIntensityColor(10, 10)).toMatch(/^hsl\(2\d{1}deg/);
  });
});

describe('heatmapContextColor', () => {
  it('never fades all the way to white, even for an idle cell', () => {
    const lightnessOf = (color: string) => Number(color.match(/(\d+)%\)$/)?.[1]);
    expect(lightnessOf(heatmapContextColor(0, 10))).toBeLessThan(90);
  });

  it('is deterministic for the same ratio', () => {
    expect(heatmapContextColor(5, 10)).toBe(heatmapContextColor(5, 10));
  });

  it('gets darker as the count approaches the max', () => {
    const lightnessOf = (color: string) => Number(color.match(/(\d+)%\)$/)?.[1]);
    expect(lightnessOf(heatmapContextColor(10, 10))).toBeLessThan(
      lightnessOf(heatmapContextColor(1, 10)),
    );
  });

  it('uses a saturated blue hue', () => {
    const color = heatmapContextColor(10, 10);
    expect(color).toMatch(/^hsl\(214deg/);
    const saturation = Number(color.match(/deg (\d+)%/)?.[1]);
    expect(saturation).toBeGreaterThanOrEqual(90);
  });
});

describe('cellInSelection', () => {
  const g = grid([
    [0, 0, 0],
    [0, 0, 0],
  ]);

  it('treats every cell as selected when there is no time window', () => {
    expect(cellInSelection(g, 0, 0, undefined)).toBe(true);
    expect(cellInSelection(g, 1, 2, null)).toBe(true);
  });

  it('treats every cell as selected when the window holds no instant', () => {
    expect(cellInSelection(g, 1, 0, [5, 5])).toBe(true);
  });

  it('is true for a cell whose start falls inside the window', () => {
    // Column 0 starts at t=0, column 1 at t=1_000_000_000.
    expect(cellInSelection(g, 0, 0, [0, 1_000_000_000])).toBe(true);
    expect(cellInSelection(g, 1, 0, [0, 1_000_000_000])).toBe(false);
  });

  it('is half-open on the window end', () => {
    expect(cellInSelection(g, 1, 0, [1_000_000_000, 2_000_000_000])).toBe(true);
    expect(cellInSelection(g, 2, 0, [1_000_000_000, 2_000_000_000])).toBe(false);
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
