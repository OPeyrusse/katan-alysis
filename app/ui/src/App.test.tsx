import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createProfileStore } from './state/profile';
import type { ProfileSummary, TopMethods } from './api/client';

const summary: ProfileSummary = {
  sample_count: 504,
  duration_nanos: 3_200_000_000,
  threads: [
    { id: 0, name: 'main' },
    { id: 1, name: 'fixture-worker' },
  ],
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

function mockedStore() {
  const client = {
    openRecording: vi.fn().mockResolvedValue(summary),
    getTopMethods: vi.fn().mockResolvedValue(topMethods),
  };
  return { store: createProfileStore(client), client };
}

describe('App', () => {
  it('renders the empty state before any recording is opened', () => {
    render(() => <App store={mockedStore().store} />);
    expect(screen.getByText('Open a JFR recording to get started.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('opens a recording and shows the top-methods table', async () => {
    const { store, client } = mockedStore();
    render(() => <App store={store} />);

    await userEvent.type(screen.getByLabelText(/JFR file path/), '/tmp/rec.jfr');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(client.openRecording).toHaveBeenCalledWith('/tmp/rec.jfr');
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(client.getTopMethods).toHaveBeenCalledWith({});
    expect(screen.getByText(/504 samples/)).toBeInTheDocument();
    expect(
      screen.getByRole('row', { name: /FixtureWorkload\.expensiveLeaf/ }),
    ).toBeInTheDocument();
  });

  it('surfaces backend errors', async () => {
    const client = {
      openRecording: vi.fn().mockRejectedValue('cannot open /bad.jfr'),
      getTopMethods: vi.fn(),
    };
    render(() => <App store={createProfileStore(client)} />);

    await userEvent.type(screen.getByLabelText(/JFR file path/), '/bad.jfr');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('cannot open /bad.jfr'),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
