import { describe, expect, it } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { HeatmapView } from './HeatmapView';
import type { HeatmapGrid, ProfileSummary, RelativeFilters } from '../../api/client';
import type { ProfileStore } from '../../state/profile';

const summary: ProfileSummary = {
  sample_count: 10,
  duration_nanos: 2_000_000_000,
  threads: [],
  thread_sample_counts: [],
  frames: [],
};

function grid(): HeatmapGrid {
  // Two columns, two rows: column 0 holds all the samples, column 1 is idle.
  const columns = [
    [4, 6],
    [0, 0],
  ];
  return {
    column_nanos: 1_000_000_000,
    row_nanos: 500_000_000,
    rows: 2,
    columns,
    max_count: 6,
    context_columns: columns,
    context_max_count: 6,
  };
}

// Only `heatmap`, `filters` and `setFilters` are exercised by this view.
function heatmapStore(initial: HeatmapGrid | undefined = grid()) {
  const [heatmap, setHeatmap] = createSignal(initial);
  const [filters, setFilters] = createSignal<RelativeFilters>({});
  const store = { heatmap, filters, setFilters } as unknown as ProfileStore;
  return { store, setHeatmap, filters };
}

function renderView(store: ProfileStore) {
  render(() => <HeatmapView store={store} summary={summary} />);
  const surface = screen.getByTestId('heatmap-surface');
  // jsdom has no layout: give the surface a concrete geometry.
  surface.getBoundingClientRect = () =>
    ({ left: 0, width: 100, top: 0, height: 100, right: 100, bottom: 100 }) as DOMRect;
  return surface;
}

// jsdom's PointerEvent constructor drops clientX/clientY; a MouseEvent with
// the pointer event type reaches Solid's onPointer* handlers just the same.
function firePointer(target: Element, type: string, clientX: number, clientY: number) {
  target.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true }));
}

describe('HeatmapView', () => {
  it('shows the sample count of the current selection', () => {
    const { store } = heatmapStore();
    renderView(store);
    expect(screen.getByText('10 samples in selection')).toBeInTheDocument();
  });

  it('shows an empty message when the recording holds no sample anywhere', () => {
    const { store } = heatmapStore({
      column_nanos: 1_000_000_000,
      row_nanos: 500_000_000,
      rows: 2,
      columns: [[0, 0]],
      max_count: 0,
      context_columns: [[0, 0]],
      context_max_count: 0,
    });
    render(() => <HeatmapView store={store} summary={summary} />);
    expect(screen.getByText('No samples in this recording.')).toBeInTheDocument();
    expect(screen.queryByTestId('heatmap-surface')).not.toBeInTheDocument();
  });

  it('still renders the surface when the selection is empty but the recording has other activity', () => {
    const { store } = heatmapStore({
      column_nanos: 1_000_000_000,
      row_nanos: 500_000_000,
      rows: 2,
      columns: [[0, 0]],
      max_count: 0,
      context_columns: [[4, 6]],
      context_max_count: 6,
    });
    render(() => <HeatmapView store={store} summary={summary} />);
    expect(screen.queryByText('No samples in this recording.')).not.toBeInTheDocument();
    expect(screen.getByTestId('heatmap-surface')).toBeInTheDocument();
  });

  it('reports the hovered cell', () => {
    const { store } = heatmapStore();
    const surface = renderView(store);

    // x=0.2 -> column 0, y=0.2 -> row 0: 4 samples at t=0:00.
    firePointer(surface, 'pointermove', 20, 20);
    expect(screen.getByText(/0:00 — 4 samples/)).toBeInTheDocument();
  });

  it('dragging across a whole column sets a time filter spanning it', () => {
    const { store } = heatmapStore();
    const surface = renderView(store);

    // Column 0 only (x in [0, 0.5)), from row 0 to row 1: the whole column.
    firePointer(surface, 'pointerdown', 10, 10);
    firePointer(surface, 'pointermove', 40, 90);
    firePointer(surface, 'pointerup', 40, 90);

    expect(store.filters()).toEqual({ time_range_nanos: [0, 1_000_000_000] });
  });

  it('dragging within one column narrows to a slice inside a second', () => {
    const { store } = heatmapStore();
    const surface = renderView(store);

    // Column 0, row 0 only: [0, 500ms).
    firePointer(surface, 'pointerdown', 10, 10);
    firePointer(surface, 'pointermove', 40, 40);
    firePointer(surface, 'pointerup', 40, 40);

    expect(store.filters()).toEqual({ time_range_nanos: [0, 500_000_000] });
  });

  it('preserves the thread filter already in place', () => {
    const [heatmap] = createSignal(grid());
    const [filters, setFilters] = createSignal<RelativeFilters>({ threads: [1] });
    const store = { heatmap, filters, setFilters } as unknown as ProfileStore;
    const surface = renderView(store);

    firePointer(surface, 'pointerdown', 10, 10);
    firePointer(surface, 'pointerup', 10, 10);

    expect(store.filters()).toEqual({
      threads: [1],
      time_range_nanos: [0, 500_000_000],
    });
  });
});
