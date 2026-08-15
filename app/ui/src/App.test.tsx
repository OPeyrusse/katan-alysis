import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createProfileStore } from './state/profile';
import type { Shell } from './api/shell';
import type { ProfileSummary, TopMethods } from './api/client';

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

function mockedClient() {
  return {
    openRecording: vi.fn().mockResolvedValue(summary),
    closeRecording: vi.fn().mockResolvedValue(undefined),
    getTopMethods: vi.fn().mockResolvedValue(topMethods),
    getSampleDensity: vi.fn().mockResolvedValue({ bucket_nanos: 1, counts: [1, 2, 1] }),
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
  await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
  return { client, store, shell };
}

describe('App', () => {
  it('shows the welcome screen before any recording is opened', () => {
    render(() => <App store={createProfileStore(mockedClient())} shell={noShell()} />);
    expect(screen.getByRole('heading', { name: 'katan-alysis' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('opens a recording into the top-methods view', async () => {
    const { client } = await openedApp();

    expect(client.openRecording).toHaveBeenCalledWith('/tmp/rec.jfr');
    expect(client.getTopMethods).toHaveBeenCalledWith({});
    expect(screen.getByText('rec.jfr')).toBeInTheDocument();
    expect(screen.getByText(/504 samples in selection/)).toBeInTheDocument();
    expect(
      screen.getByRole('row', { name: /FixtureWorkload\.expensiveLeaf/ }),
    ).toBeInTheDocument();
    // The sidebar shows the recording vitals.
    expect(screen.getByText('3.2 s')).toBeInTheDocument();
  });

  it('navigates between the built views and disables the future ones', async () => {
    await openedApp();

    const overview = screen.getByRole('button', { name: 'Overview' });
    await userEvent.click(overview);
    expect(screen.getByText('The overview charts are not built yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Top methods' }));
    expect(screen.getByRole('table')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Flamegraph' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Heatmap' })).toBeDisabled();
  });

  it('closes the recording back to the welcome screen', async () => {
    const { client } = await openedApp();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(client.closeRecording).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'katan-alysis' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
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
