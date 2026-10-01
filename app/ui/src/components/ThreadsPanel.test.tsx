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

  it('starts with no thread ticked, filtering nothing', () => {
    createRoot((dispose) => {
      const store = filterStore();
      renderPanel(store);
      expect(screen.getByText('Threads (all)')).toBeInTheDocument();
      expect(screen.getAllByRole('checkbox').some((c) => (c as HTMLInputElement).checked)).toBe(
        false,
      );
      expect(store.filters().threads).toBeUndefined();
      expect(screen.getByText(/every thread is included/)).toBeInTheDocument();
      dispose();
    });
  });

  it('narrows to the single thread picked first, rather than excluding it', async () => {
    const store = filterStore();
    renderPanel(store);

    await userEvent.click(screen.getByRole('checkbox', { name: /main/ }));
    expect(store.filters().threads).toEqual([0]);
    expect(screen.getByText('Threads (1/3)')).toBeInTheDocument();
  });

  it('keeps the time filter when the first thread is picked', async () => {
    const store = filterStore();
    store.setFilters({ time_range_nanos: [0, 500] });
    renderPanel(store);

    await userEvent.click(screen.getByRole('checkbox', { name: /worker-1/ }));
    expect(store.filters().threads).toEqual([1]);
    expect(store.filters().time_range_nanos).toEqual([0, 500]);
  });

  it('adds and removes threads once a filter exists', async () => {
    const store = filterStore();
    store.setFilters({ threads: [1] });
    renderPanel(store);

    await userEvent.click(screen.getByRole('checkbox', { name: /worker-2/ }));
    expect(store.filters().threads).toEqual([1, 2]);

    await userEvent.click(screen.getByRole('checkbox', { name: /worker-1/ }));
    expect(store.filters().threads).toEqual([2]);
    expect(screen.getByText('Threads (1/3)')).toBeInTheDocument();
  });

  it('unticking the last ticked thread drops the filter instead of emptying it', async () => {
    const store = filterStore();
    store.setFilters({ threads: [1] });
    renderPanel(store);

    await userEvent.click(screen.getByRole('checkbox', { name: /worker-1/ }));
    expect(store.filters().threads).toBeUndefined();
    expect(screen.getByText('Threads (all)')).toBeInTheDocument();
  });

  it('ticking every thread collapses back to no filter', async () => {
    const store = filterStore();
    store.setFilters({ threads: [1, 2] });
    renderPanel(store);

    await userEvent.click(screen.getByRole('checkbox', { name: /main/ }));
    expect(store.filters().threads).toBeUndefined();
  });

  it('Clear drops the thread filter without touching the time filter', async () => {
    const store = filterStore();
    store.setFilters({ threads: [1], time_range_nanos: [0, 500] });
    renderPanel(store);

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(store.filters().threads).toBeUndefined();
    expect(store.filters().time_range_nanos).toEqual([0, 500]);
  });

  it('offers no Clear while there is no thread filter', () => {
    createRoot((dispose) => {
      renderPanel(filterStore());
      expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
      dispose();
    });
  });

  it('Invert flips the selection', async () => {
    const store = filterStore();
    store.setFilters({ threads: [1] });
    renderPanel(store);

    await userEvent.click(screen.getByRole('button', { name: 'Invert' }));
    expect(store.filters().threads).toEqual(expect.arrayContaining([0, 2]));
    expect(store.filters().threads).toHaveLength(2);
  });

  it('Invert on the unfiltered panel stays unfiltered', async () => {
    const store = filterStore();
    renderPanel(store);

    await userEvent.click(screen.getByRole('button', { name: 'Invert' }));
    expect(store.filters().threads).toBeUndefined();
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
