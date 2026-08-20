import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { RecordingTabs } from './RecordingTabs';
import { createProfileStore } from '../state/profile';
import type { ProfileSummary } from '../api/client';
import { emptyMergedCalls, emptySignals, nullInfo } from '../test/fixtures';

const summary: ProfileSummary = {
  sample_count: 100,
  duration_nanos: 1_000_000_000,
  threads: [{ id: 0, name: 'main' }],
  thread_sample_counts: [100],
  frames: [],
};

function mockedClient() {
  return {
    openRecording: vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve({ handle: path === '/a.jfr' ? 1 : 2, summary }),
      ),
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

async function storeWithTwoRecordings() {
  const client = mockedClient();
  const store = createProfileStore(client);
  await store.open('/a.jfr');
  await store.open('/b.jfr');
  return { client, store };
}

describe('RecordingTabs', () => {
  it('shows one tab per open recording, labeled by basename', async () => {
    const { store } = await storeWithTwoRecordings();
    render(() => <RecordingTabs store={store} onAddRecording={() => {}} />);

    expect(screen.getByRole('button', { name: 'a.jfr' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'b.jfr' })).toBeInTheDocument();
  });

  it('marks the active tab', async () => {
    const { store } = await storeWithTwoRecordings();
    render(() => <RecordingTabs store={store} onAddRecording={() => {}} />);

    // /b.jfr was opened last, so it is the active recording.
    expect(screen.getByRole('button', { name: 'b.jfr' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'a.jfr' })).not.toHaveAttribute('aria-current');
  });

  it('clicking a non-active tab switches to it', async () => {
    const { store } = await storeWithTwoRecordings();
    render(() => <RecordingTabs store={store} onAddRecording={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: 'a.jfr' }));

    expect(store.activeHandle()).toBe(1);
    expect(store.openedPath()).toBe('/a.jfr');
  });

  it('closing a tab closes that handle, not necessarily the active one', async () => {
    const { client, store } = await storeWithTwoRecordings();
    client.listOpenRecordings.mockResolvedValue([{ handle: 2, is_active: true, summary }]);
    render(() => <RecordingTabs store={store} onAddRecording={() => {}} />);

    // /b.jfr (handle 2) is active; close the inactive /a.jfr (handle 1).
    await userEvent.click(screen.getByRole('button', { name: 'Close a.jfr' }));

    expect(client.closeRecording).toHaveBeenCalledWith(1);
    expect(store.activeHandle()).toBe(2);
    expect(store.openRecordings().map((r) => r.handle)).toEqual([2]);
  });

  it('closing a tab does not also select it', async () => {
    const { client, store } = await storeWithTwoRecordings();
    client.listOpenRecordings.mockResolvedValue([{ handle: 2, is_active: true, summary }]);
    render(() => <RecordingTabs store={store} onAddRecording={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: 'Close a.jfr' }));

    // activateRecording (fired by selectRecording) must never have been
    // called with the tab being closed.
    expect(client.activateRecording).not.toHaveBeenCalledWith(1);
  });

  it('the trailing + button invokes onAddRecording', async () => {
    const { store } = await storeWithTwoRecordings();
    const onAddRecording = vi.fn();
    render(() => <RecordingTabs store={store} onAddRecording={onAddRecording} />);

    await userEvent.click(screen.getByRole('button', { name: 'Open another recording' }));

    expect(onAddRecording).toHaveBeenCalledTimes(1);
  });
});
