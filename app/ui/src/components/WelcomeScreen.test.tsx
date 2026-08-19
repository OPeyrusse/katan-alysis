import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { WelcomeScreen } from './WelcomeScreen';
import { createProfileStore } from '../state/profile';
import type { Shell } from '../api/shell';
import type { ProfileSummary, RecentRecording } from '../api/client';
import { emptyMergedCalls, emptySignals, nullInfo } from '../test/fixtures';

const summary: ProfileSummary = {
  sample_count: 10,
  duration_nanos: 1_000,
  threads: [],
  thread_sample_counts: [],
  frames: [],
};

const recents: RecentRecording[] = [
  {
    path: '/perf/prod/payment.jfr',
    size_bytes: 512 * 1024 * 1024,
    last_opened_ms: 0,
    exists: true,
  },
  { path: '/tmp/startup.jfr', size_bytes: 48 * 1024 * 1024, last_opened_ms: 0, exists: true },
];

function mockedClient() {
  return {
    openRecording: vi.fn().mockResolvedValue(summary),
    closeRecording: vi.fn().mockResolvedValue(undefined),
    getTopMethods: vi.fn().mockResolvedValue({ rows: [], total_samples: 10 }),
    getFlamegraph: vi.fn().mockResolvedValue({ frame: null, samples: 0, children: [] }),
    getHeatmap: vi
      .fn()
      .mockResolvedValue({ column_nanos: 0, row_nanos: 0, rows: 0, columns: [], max_count: 0 }),
    getMergedCalls: vi.fn().mockResolvedValue(emptyMergedCalls()),
    getSampleDensity: vi.fn().mockResolvedValue({ bucket_nanos: 1, counts: [] }),
    getRecordingInfo: vi.fn().mockResolvedValue(nullInfo()),
    getOverviewSignals: vi.fn().mockResolvedValue(emptySignals()),
    listRecentRecordings: vi.fn().mockResolvedValue(recents),
    removeRecentRecording: vi.fn().mockResolvedValue([recents[1]]),
    clearRecentRecordings: vi.fn().mockResolvedValue([]),
  };
}

function noShell(): Shell {
  return {
    pickRecordingFile: vi.fn().mockResolvedValue(null),
    onFileDrop: vi.fn().mockResolvedValue(() => {}),
  };
}

describe('WelcomeScreen', () => {
  it('lists the recent recordings with their details', async () => {
    const store = createProfileStore(mockedClient());
    render(() => <WelcomeScreen store={store} shell={noShell()} />);

    expect(await screen.findByText('payment.jfr')).toBeInTheDocument();
    expect(screen.getByText(/\/perf\/prod · 512\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText('startup.jfr')).toBeInTheDocument();
  });

  it('shows an empty state without recents', async () => {
    const client = mockedClient();
    client.listRecentRecordings.mockResolvedValue([]);
    const store = createProfileStore(client);
    render(() => <WelcomeScreen store={store} shell={noShell()} />);

    expect(await screen.findByText('No recent recordings yet.')).toBeInTheDocument();
  });

  it('opens a recent recording on click', async () => {
    const client = mockedClient();
    const store = createProfileStore(client);
    render(() => <WelcomeScreen store={store} shell={noShell()} />);

    await userEvent.click(await screen.findByText('payment.jfr'));
    expect(client.openRecording).toHaveBeenCalledWith('/perf/prod/payment.jfr');
  });

  it('removes a recent without opening it', async () => {
    const client = mockedClient();
    const store = createProfileStore(client);
    render(() => <WelcomeScreen store={store} shell={noShell()} />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove payment.jfr from recents' }),
    );
    expect(client.removeRecentRecording).toHaveBeenCalledWith('/perf/prod/payment.jfr');
    expect(client.openRecording).not.toHaveBeenCalled();
    expect(screen.queryByText('payment.jfr')).not.toBeInTheDocument();
  });

  it('clears the whole list', async () => {
    const client = mockedClient();
    const store = createProfileStore(client);
    render(() => <WelcomeScreen store={store} shell={noShell()} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    expect(client.clearRecentRecordings).toHaveBeenCalled();
    expect(await screen.findByText('No recent recordings yet.')).toBeInTheDocument();
  });

  it('opens the file returned by the native picker', async () => {
    const client = mockedClient();
    const store = createProfileStore(client);
    const shell = noShell();
    (shell.pickRecordingFile as ReturnType<typeof vi.fn>).mockResolvedValue('/picked.jfr');
    render(() => <WelcomeScreen store={store} shell={shell} />);

    await userEvent.click(screen.getByRole('button', { name: /Open a file/ }));
    expect(client.openRecording).toHaveBeenCalledWith('/picked.jfr');
  });

  it('does nothing when the picker is cancelled', async () => {
    const client = mockedClient();
    const store = createProfileStore(client);
    render(() => <WelcomeScreen store={store} shell={noShell()} />);

    await userEvent.click(screen.getByRole('button', { name: /Open a file/ }));
    expect(client.openRecording).not.toHaveBeenCalled();
  });

  it('marks a vanished file as missing and refuses to open it', async () => {
    const client = mockedClient();
    client.listRecentRecordings.mockResolvedValue([{ ...recents[0], exists: false }]);
    const store = createProfileStore(client);
    render(() => <WelcomeScreen store={store} shell={noShell()} />);

    const entry = await screen.findByText('payment.jfr');
    expect(screen.getByText(/file not found/)).toBeInTheDocument();
    await userEvent.click(entry);
    expect(client.openRecording).not.toHaveBeenCalled();
    // The dead entry can still be removed.
    expect(
      screen.getByRole('button', { name: 'Remove payment.jfr from recents' }),
    ).toBeEnabled();
  });

  it('shows the open in progress and blocks a second one', async () => {
    const client = mockedClient();
    let finish!: (value: ProfileSummary) => void;
    client.openRecording.mockImplementation(
      () => new Promise<ProfileSummary>((resolve) => (finish = resolve)),
    );
    const store = createProfileStore(client);
    render(() => <WelcomeScreen store={store} shell={noShell()} />);

    const first = store.open('/slow/one.jfr');
    expect(await screen.findByRole('status')).toHaveTextContent('Opening one.jfr…');
    expect(screen.getByRole('button', { name: /Open a file/ })).toBeDisabled();

    // A second open while parsing is ignored rather than racing.
    void store.open('/slow/two.jfr');
    expect(client.openRecording).toHaveBeenCalledTimes(1);

    finish(summary);
    await first;
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('still opens a typed path', async () => {
    const client = mockedClient();
    const store = createProfileStore(client);
    render(() => <WelcomeScreen store={store} shell={noShell()} />);

    await userEvent.type(screen.getByLabelText(/Open by path/), '/typed.jfr');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(client.openRecording).toHaveBeenCalledWith('/typed.jfr');
  });
});
