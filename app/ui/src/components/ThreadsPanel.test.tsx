import { describe, expect, it } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { createRoot } from 'solid-js';
import { createSignal } from 'solid-js';
import { ThreadsPanel } from './ThreadsPanel';
import type { ProfileSummary, RelativeFilters } from '../api/client';
import type { ProfileStore } from '../state/profile';

const summary: ProfileSummary = {
  sample_count: 100,
  duration_nanos: 1_000_000_000,
  threads: [
    { id: 0, name: 'main' },
    { id: 1, name: 'worker-1' },
    { id: 2, name: 'worker-2' },
  ],
  thread_sample_counts: [10, 60, 30],
  frames: [],
};

// The panel only touches filters/setFilters; a stub keeps the tests focused.
function filterStore(): ProfileStore {
  const [filters, setFilters] = createSignal<RelativeFilters>({});
  return { filters, setFilters } as unknown as ProfileStore;
}

function renderPanel(store: ProfileStore) {
  render(() => <ThreadsPanel store={store} summary={summary} />);
}

describe('ThreadsPanel', () => {
  it('orders threads by decreasing activity with their share', () => {
    createRoot((dispose) => {
      renderPanel(filterStore());
      const names = screen.getAllByRole('listitem').map((li) => li.textContent);
      expect(names[0]).toContain('worker-1');
      expect(names[0]).toContain('60 %');
      expect(names[1]).toContain('worker-2');
      expect(names[2]).toContain('main');
      dispose();
    });
  });

  it('starts with every thread selected', () => {
    createRoot((dispose) => {
      renderPanel(filterStore());
      expect(screen.getByText('Threads (3/3)')).toBeInTheDocument();
      expect(screen.getAllByRole('checkbox').every((c) => (c as HTMLInputElement).checked)).toBe(
        true,
      );
      dispose();
    });
  });

  it('unchecking a thread narrows the filter to the others', async () => {
    const store = filterStore();
    renderPanel(store);

    await userEvent.click(screen.getByRole('checkbox', { name: /main/ }));
    expect(store.filters().threads).toEqual(expect.arrayContaining([1, 2]));
    expect(store.filters().threads).toHaveLength(2);
    expect(screen.getByText('Threads (2/3)')).toBeInTheDocument();
  });

  it('re-checking the last missing thread widens back to no filter', async () => {
    const store = filterStore();
    store.setFilters({ threads: [1, 2] });
    renderPanel(store);

    await userEvent.click(screen.getByRole('checkbox', { name: /main/ }));
    expect(store.filters().threads).toBeUndefined();
  });

  it('None empties the selection without touching the time filter', async () => {
    const store = filterStore();
    store.setFilters({ time_range_nanos: [0, 500] });
    renderPanel(store);

    await userEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(store.filters().threads).toEqual([]);
    expect(store.filters().time_range_nanos).toEqual([0, 500]);
    expect(screen.getByText('Threads (0/3)')).toBeInTheDocument();
  });

  it('All restores the unfiltered state', async () => {
    const store = filterStore();
    store.setFilters({ threads: [1] });
    renderPanel(store);

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(store.filters().threads).toBeUndefined();
  });

  it('Invert flips the selection', async () => {
    const store = filterStore();
    store.setFilters({ threads: [1] });
    renderPanel(store);

    await userEvent.click(screen.getByRole('button', { name: 'Invert' }));
    expect(store.filters().threads).toEqual(expect.arrayContaining([0, 2]));
    expect(store.filters().threads).toHaveLength(2);
  });

  it('filters the list by name without changing the selection', async () => {
    const store = filterStore();
    renderPanel(store);

    await userEvent.type(screen.getByLabelText('Filter threads by name'), 'worker');
    expect(screen.queryByText('main')).not.toBeInTheDocument();
    expect(screen.getByText('worker-1')).toBeInTheDocument();
    expect(store.filters().threads).toBeUndefined();
  });
});
