import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createProfileStore } from './state/profile';
import type { Shell } from './api/shell';
import type {
  FlameNode,
  HeatmapGrid,
  MergedCallTree,
  ProfileSummary,
  TopMethods,
} from './api/client';
import { emptySignals, nullInfo } from './test/fixtures';

const summary: ProfileSummary = {
  sample_count: 504,
  duration_nanos: 3_200_000_000,
  threads: [
    { id: 0, name: 'main' },
    { id: 1, name: 'fixture-worker' },
  ],
  thread_sample_counts: [104, 400],
  frames: [
    { class_name: 'FixtureWorkload', method_name: 'hotCoordinator' },
    { class_name: 'FixtureWorkload', method_name: 'expensiveLeaf' },
  ],
};

const topMethods: TopMethods = {
  rows: [
    [1, { self_samples: 400, total_samples: 420 }],
    [0, { self_samples: 20, total_samples: 480 }],
  ],
  total_samples: 504,
};

const flamegraph: FlameNode = {
  frame: null,
  samples: 504,
  children: [
    { frame: 0, samples: 480, children: [{ frame: 1, samples: 420, children: [] }] },
    { frame: 1, samples: 24, children: [] },
  ],
};

const heatmap: HeatmapGrid = {
  column_nanos: 1_000_000_000,
  row_nanos: 20_000_000,
  rows: 50,
  columns: [Array(50).fill(0)],
  max_count: 0,
  context_columns: [Array(50).fill(0)],
  context_max_count: 0,
};

const mergedCalls: MergedCallTree = {
  focus: 0,
  callers: { frame: 0, samples: 480, children: [] },
  callees: { frame: 0, samples: 480, children: [{ frame: 1, samples: 420, children: [] }] },
};

function mockedClient() {
  return {
    openRecording: vi.fn().mockResolvedValue({ handle: 1, summary }),
    closeRecording: vi.fn().mockResolvedValue(undefined),
    activateRecording: vi.fn().mockResolvedValue(undefined),
    listOpenRecordings: vi.fn().mockResolvedValue([]),
    getTopMethods: vi.fn().mockResolvedValue(topMethods),
    getFlamegraph: vi.fn().mockResolvedValue(flamegraph),
    getHeatmap: vi.fn().mockResolvedValue(heatmap),
    getMergedCalls: vi.fn().mockResolvedValue(mergedCalls),
    getSampleDensity: vi.fn().mockResolvedValue({ bucket_nanos: 1, counts: [1, 2, 1] }),
    getRecordingInfo: vi.fn().mockResolvedValue(nullInfo()),
    getOverviewSignals: vi.fn().mockResolvedValue(emptySignals()),
    listRecentRecordings: vi.fn().mockResolvedValue([]),
    removeRecentRecording: vi.fn().mockResolvedValue([]),
    clearRecentRecordings: vi.fn().mockResolvedValue([]),
  };
}

function noShell(): Shell {
  return {
    pickRecordingFile: vi.fn().mockResolvedValue(null),
    onFileDrop: vi.fn().mockResolvedValue(() => {}),
  };
}

async function openedApp() {
  const client = mockedClient();
  const store = createProfileStore(client);
  const shell = noShell();
  render(() => <App store={store} shell={shell} />);
  await userEvent.type(screen.getByLabelText(/Open by path/), '/tmp/rec.jfr');
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
  // A fresh recording lands on the overview.
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'Overview view' })).toBeInTheDocument(),
  );
  return { client, store, shell };
}

async function openedTopMethods() {
  const opened = await openedApp();
  await userEvent.click(screen.getByRole('button', { name: 'Top methods' }));
  await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
  return opened;
}

describe('App', () => {
  it('shows the welcome screen before any recording is opened', () => {
    render(() => <App store={createProfileStore(mockedClient())} shell={noShell()} />);
    expect(screen.getByRole('heading', { name: 'katan-alysis' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('opens a recording into the overview, then reaches top methods', async () => {
    const { client } = await openedTopMethods();

    expect(client.openRecording).toHaveBeenCalledWith('/tmp/rec.jfr');
    expect(client.getTopMethods).toHaveBeenCalledWith(1, {});
    expect(screen.getByText('rec.jfr')).toBeInTheDocument();
    expect(screen.getByText(/504 samples in selection/)).toBeInTheDocument();
    expect(
      screen.getByRole('row', { name: /FixtureWorkload\.expensiveLeaf/ }),
    ).toBeInTheDocument();
    // The sidebar shows the recording vitals.
    expect(screen.getByText('3.2 s')).toBeInTheDocument();
  });

  it('navigates between the built views and disables the future ones', async () => {
    await openedTopMethods();

    await userEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByRole('region', { name: 'Overview view' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Top methods' }));
    expect(screen.getByRole('table')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Flamegraph' }));
    expect(screen.getByRole('region', { name: 'Flamegraph view' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Heatmap' }));
    expect(screen.getByRole('region', { name: 'Heatmap view' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Merged calls' }));
    expect(screen.getByRole('region', { name: 'Merged calls view' })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'GC' })).toBeDisabled();
  });

  it('selecting a method from top-methods opens the merged-calls view on it', async () => {
    const { client } = await openedTopMethods();

    await userEvent.click(screen.getByRole('button', { name: 'FixtureWorkload.hotCoordinator' }));

    expect(screen.getByRole('region', { name: 'Merged calls view' })).toBeInTheDocument();
    await waitFor(() => expect(client.getMergedCalls).toHaveBeenCalledWith(1, 0, {}));
    expect(screen.getByText(/Focused on/)).toHaveTextContent('FixtureWorkload.hotCoordinator');
  });

  it('merged calls shows a prompt before any method is selected', async () => {
    await openedTopMethods();

    await userEvent.click(screen.getByRole('button', { name: 'Merged calls' }));

    expect(screen.getByText(/Select a method from Top methods or the Flamegraph/)).toBeInTheDocument();
  });

  it('closes the recording back to the welcome screen', async () => {
    const { client } = await openedApp();

    await userEvent.click(screen.getByRole('button', { name: 'Close rec.jfr' }));
    expect(client.closeRecording).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'katan-alysis' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('opening a second recording shows two tabs and switches the active one', async () => {
    const { client, store } = await openedApp();
    client.openRecording.mockImplementation((path: string) =>
      Promise.resolve({ handle: path === '/tmp/rec.jfr' ? 1 : 2, summary }),
    );

    await store.open('/tmp/other.jfr');

    await waitFor(() => expect(screen.getByText('other.jfr')).toBeInTheDocument());
    expect(screen.getByText('rec.jfr')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'other.jfr' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await userEvent.click(screen.getByRole('button', { name: 'rec.jfr' }));
    expect(screen.getByRole('button', { name: 'rec.jfr' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: 'other.jfr' })).not.toHaveAttribute('aria-current');
  });

  it('opens a dropped file', async () => {
    const client = mockedClient();
    const store = createProfileStore(client);
    const shell = noShell();
    let drop: ((path: string) => void) | undefined;
    (shell.onFileDrop as ReturnType<typeof vi.fn>).mockImplementation(
      (handler: (path: string) => void) => {
        drop = handler;
        return Promise.resolve(() => {});
      },
    );
    render(() => <App store={store} shell={shell} />);

    expect(drop).toBeDefined();
    drop!('/dropped.jfr');
    await waitFor(() => expect(client.openRecording).toHaveBeenCalledWith('/dropped.jfr'));
  });

  it('Ctrl+O opens the native picker', async () => {
    const client = mockedClient();
    const store = createProfileStore(client);
    const shell = noShell();
    (shell.pickRecordingFile as ReturnType<typeof vi.fn>).mockResolvedValue('/picked.jfr');
    render(() => <App store={store} shell={shell} />);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true }));
    await waitFor(() => expect(client.openRecording).toHaveBeenCalledWith('/picked.jfr'));
  });

  it('Ctrl+R reopens the most recent recording still on disk', async () => {
    const client = mockedClient();
    client.listRecentRecordings.mockResolvedValue([
      { path: '/gone.jfr', size_bytes: 1, last_opened_ms: 2, exists: false },
      { path: '/latest.jfr', size_bytes: 1, last_opened_ms: 1, exists: true },
    ]);
    const store = createProfileStore(client);
    render(() => <App store={store} shell={noShell()} />);
    await waitFor(() => expect(store.recents()).toHaveLength(2));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true }));
    await waitFor(() => expect(client.openRecording).toHaveBeenCalledWith('/latest.jfr'));
  });

  it('surfaces backend errors on the welcome screen', async () => {
    const client = mockedClient();
    client.openRecording.mockRejectedValue('cannot open /bad.jfr');
    render(() => <App store={createProfileStore(client)} shell={noShell()} />);

    await userEvent.type(screen.getByLabelText(/Open by path/), '/bad.jfr');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('cannot open /bad.jfr'),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
