import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { SelectionBar } from './SelectionBar';
import { createProfileStore } from '../state/profile';
import type { ProfileSummary } from '../api/client';
import { emptyMergedCalls, emptySignals, nullInfo } from '../test/fixtures';

const summary: ProfileSummary = {
  sample_count: 100,
  duration_nanos: 1_000_000_000,
  threads: [
    { id: 0, name: 'main' },
    { id: 1, name: 'worker' },
  ],
  thread_sample_counts: [40, 60],
  frames: [],
};

function mockedClient() {
  return {
    openRecording: vi.fn().mockResolvedValue({ handle: 1, summary }),
    closeRecording: vi.fn().mockResolvedValue(undefined),
    activateRecording: vi.fn().mockResolvedValue(undefined),
    listOpenRecordings: vi.fn().mockResolvedValue([]),
    getTopMethods: vi.fn().mockResolvedValue({ rows: [], total_samples: 100 }),
    getFlamegraph: vi.fn().mockResolvedValue({ frame: null, samples: 0, children: [] }),
    getHeatmap: vi
      .fn()
      .mockResolvedValue({ column_nanos: 0, row_nanos: 0, rows: 0, columns: [], max_count: 0 }),
    getMergedCalls: vi.fn().mockResolvedValue(emptyMergedCalls()),
    getSampleDensity: vi.fn().mockResolvedValue({ bucket_nanos: 1, counts: [1] }),
    getRecordingInfo: vi.fn().mockResolvedValue(nullInfo()),
    getOverviewSignals: vi.fn().mockResolvedValue(emptySignals()),
    listRecentRecordings: vi.fn().mockResolvedValue([]),
    removeRecentRecording: vi.fn().mockResolvedValue([]),
    clearRecentRecordings: vi.fn().mockResolvedValue([]),
  };
}

async function openedStore() {
  const store = createProfileStore(mockedClient());
  await store.open('/rec.jfr');
  return store;
}

describe('SelectionBar', () => {
  it('shows the unnarrowed state with Save disabled', async () => {
    const store = await openedStore();
    render(() => <SelectionBar store={store} />);

    expect(screen.getByText('whole recording · all threads')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('marks an unsaved selection and saves it under its default name', async () => {
    const store = await openedStore();
    render(() => <SelectionBar store={store} />);

    store.setFilters({ threads: [1] });
    expect(screen.getByText(/\(unsaved\)/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(store.selections().map((s) => s.name)).toEqual(['whole recording · 1 thread']);
    expect(
      screen.getByRole('option', { name: 'whole recording · 1 thread' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('whole recording · 1 thread');
    // The freshly saved selection is applied: no second save of the same.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('applies a saved selection from the dropdown', async () => {
    const store = await openedStore();
    store.setFilters({ threads: [1] });
    const name = store.saveSelection();
    store.clearSelection();
    render(() => <SelectionBar store={store} />);

    await userEvent.selectOptions(screen.getByRole('combobox'), name);
    expect(store.filters()).toEqual({ threads: [1] });
    expect(store.appliedSelection()).toBe(name);
  });

  it('the no-selection entry clears the filters', async () => {
    const store = await openedStore();
    store.setFilters({ threads: [1], time_range_nanos: [0, 500] });
    store.saveSelection();
    render(() => <SelectionBar store={store} />);

    await userEvent.selectOptions(screen.getByRole('combobox'), '');
    expect(store.filters()).toEqual({});
    expect(store.appliedSelection()).toBeUndefined();
  });

  it('renames the applied selection', async () => {
    const store = await openedStore();
    store.setFilters({ threads: [1] });
    store.saveSelection();
    render(() => <SelectionBar store={store} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rename selection' }));
    const input = screen.getByRole('textbox', { name: 'New selection name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'peak load{Enter}');

    expect(store.selections().map((s) => s.name)).toEqual(['peak load']);
    expect(screen.getByRole('combobox')).toHaveValue('peak load');
  });

  it('deletes the applied selection but keeps the filters', async () => {
    const store = await openedStore();
    store.setFilters({ threads: [1] });
    store.saveSelection();
    render(() => <SelectionBar store={store} />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete selection' }));
    expect(store.selections()).toEqual([]);
    expect(store.filters()).toEqual({ threads: [1] });
    expect(screen.getByText(/\(unsaved\)/)).toBeInTheDocument();
  });
});
