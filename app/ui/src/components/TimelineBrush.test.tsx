import { describe, expect, it } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { createSignal } from 'solid-js';
import { TimelineBrush } from './TimelineBrush';
import type { ProfileSummary, RelativeFilters } from '../api/client';
import type { ProfileStore } from '../state/profile';

const summary: ProfileSummary = {
  sample_count: 100,
  duration_nanos: 1_000_000_000,
  threads: [],
  thread_sample_counts: [],
  frames: [],
};

// The brush only touches filters/setFilters and density.
function brushStore(): ProfileStore {
  const [filters, setFilters] = createSignal<RelativeFilters>({});
  const density = () => ({ bucket_nanos: 100, counts: [1, 3, 2] });
  return { filters, setFilters, density } as unknown as ProfileStore;
}

function renderBrush(store: ProfileStore) {
  render(() => <TimelineBrush store={store} summary={summary} />);
  const strip = screen.getByTestId('timeline-strip');
  // jsdom has no layout: give the canvas, which the pointer is resolved
  // against, a concrete geometry.
  const canvas = strip.querySelector('canvas')!;
  canvas.getBoundingClientRect = () =>
    ({ left: 0, width: 100, top: 0, height: 40, right: 100, bottom: 40 }) as DOMRect;
  return strip;
}

// jsdom's PointerEvent constructor drops clientX; a MouseEvent with the
// pointer event type reaches Solid's onPointer* handlers just the same.
function firePointer(target: Element, type: string, clientX = 0) {
  target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
}

describe('TimelineBrush', () => {
  it('shows the whole recording without a window', () => {
    renderBrush(brushStore());
    expect(screen.getByText(/whole recording/)).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-window')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
  });

  it('brushing commits the dragged window to the filters', () => {
    const store = brushStore();
    const strip = renderBrush(store);

    firePointer(strip, 'pointerdown', 25);
    firePointer(strip, 'pointermove', 75);
    firePointer(strip, 'pointerup');

    expect(store.filters().time_range_nanos).toEqual([250_000_000, 750_000_000]);
  });

  it('a backwards drag lands the same window', () => {
    const store = brushStore();
    const strip = renderBrush(store);

    firePointer(strip, 'pointerdown', 75);
    firePointer(strip, 'pointermove', 25);
    firePointer(strip, 'pointerup');

    expect(store.filters().time_range_nanos).toEqual([250_000_000, 750_000_000]);
  });

  it('a click that selects no instant clears the window', () => {
    const store = brushStore();
    store.setFilters({ time_range_nanos: [100, 200] });
    const strip = renderBrush(store);

    firePointer(strip, 'pointerdown', 50);
    firePointer(strip, 'pointerup');

    expect(store.filters().time_range_nanos).toBeUndefined();
  });

  it('positions the window overlay from the active filter', () => {
    const store = brushStore();
    store.setFilters({ time_range_nanos: [250_000_000, 750_000_000] });
    renderBrush(store);

    const window = screen.getByTestId('timeline-window');
    expect(window.style.left).toBe('25%');
    expect(window.style.width).toBe('50%');
    expect(screen.getByText(/0:00 → 0:00/)).toBeInTheDocument();
  });

  it('Reset clears the window but keeps the thread filter', async () => {
    const store = brushStore();
    store.setFilters({ threads: [1], time_range_nanos: [0, 500_000_000] });
    renderBrush(store);

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(store.filters().time_range_nanos).toBeUndefined();
    expect(store.filters().threads).toEqual([1]);
  });
});
