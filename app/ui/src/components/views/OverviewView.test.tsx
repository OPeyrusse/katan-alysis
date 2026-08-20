import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@solidjs/testing-library';
import { OverviewView } from './OverviewView';
import { createProfileStore } from '../../state/profile';
import { emptyMergedCalls, emptySignals, nullInfo } from '../../test/fixtures';
import type {
  OverviewSignals,
  ProfileSummary,
  RecordingInfo,
} from '../../api/client';

const summary: ProfileSummary = {
  sample_count: 100,
  duration_nanos: 4_000_000_000,
  threads: [],
  thread_sample_counts: [],
  frames: [],
};

const info: RecordingInfo = {
  jvm_name: 'OpenJDK 64-Bit Server VM',
  jvm_version: 'OpenJDK 64-Bit Server VM (21.0.10) for linux-amd64',
  young_collector: 'G1New',
  old_collector: 'G1Old',
  heap_max_bytes: 256 * 1024 * 1024,
  os_version: 'DISTRIB_ID=Ubuntu\nuname: Linux 6.18 x86_64\nlibc: glibc',
  cpu_cores: 4,
  hw_threads: 8,
  physical_memory_bytes: 16 * 1024 * 1024 * 1024,
  xmx: { value: 256 * 1024 * 1024, origin: 'Command line' },
  xms: { value: 128 * 1024 * 1024, origin: 'Ergonomic' },
  max_direct_memory: { value: 64 * 1024 * 1024, origin: 'Command line' },
  debug_non_safepoints: { value: true, origin: 'Command line' },
};

const signals: OverviewSignals = {
  cpu_jvm_user: [
    { ts_nanos: 0, value: 0.2 },
    { ts_nanos: 2_000_000_000, value: 0.6 },
  ],
  cpu_jvm_system: [{ ts_nanos: 0, value: 0.05 }],
  cpu_machine_total: [{ ts_nanos: 0, value: 0.3 }],
  heap_used_bytes: [{ ts_nanos: 0, value: 50 * 1024 * 1024 }],
  heap_committed_bytes: [{ ts_nanos: 0, value: 130 * 1024 * 1024 }],
  rss_bytes: [{ ts_nanos: 0, value: 300 * 1024 * 1024 }],
  gc_pauses: [
    { ts_nanos: 1_000_000_000, duration_nanos: 5_000_000, name: 'G1New', cause: 'Evacuation' },
  ],
};

function mockedClient(overrides?: {
  info?: RecordingInfo;
  signals?: OverviewSignals;
}) {
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
    getRecordingInfo: vi.fn().mockResolvedValue(overrides?.info ?? info),
    getOverviewSignals: vi.fn().mockResolvedValue(overrides?.signals ?? signals),
    listRecentRecordings: vi.fn().mockResolvedValue([]),
    removeRecentRecording: vi.fn().mockResolvedValue([]),
    clearRecentRecordings: vi.fn().mockResolvedValue([]),
  };
}

async function renderOverview(overrides?: Parameters<typeof mockedClient>[0]) {
  const store = createProfileStore(mockedClient(overrides));
  await store.open('/rec.jfr');
  render(() => <OverviewView store={store} summary={summary} />);
  await waitFor(() => expect(store.overviewSignals()).toBeDefined());
  return store;
}

function firePointer(target: Element, type: string, clientX = 0) {
  target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
}

describe('OverviewView', () => {
  it('shows the key facts extracted from the recording', async () => {
    await renderOverview();

    expect(await screen.findByText('OpenJDK 64-Bit Server VM')).toBeInTheDocument();
    expect(screen.getByText('G1New / G1Old')).toBeInTheDocument();
    expect(screen.getByText('Heap max 256.0 MB')).toBeInTheDocument();
    expect(screen.getByText('Linux 6.18 x86_64')).toBeInTheDocument();
    expect(screen.getByText('4 cores · 8 hw threads · 16.0 GB RAM')).toBeInTheDocument();
  });

  it('shows the Options strip with flag origins', async () => {
    await renderOverview();

    const options = await screen.findByLabelText('Options');
    expect(options.textContent).toContain('Xmx 256.0 MB');
    expect(options.textContent).toContain('Xms 128.0 MB (ergonomic)');
    expect(options.textContent).toContain('MaxDirectMemorySize 64.0 MB');
    expect(options.textContent).toContain('DebugNonSafepoints ✓ enabled');
  });

  it('renders the four charts when the signals exist', async () => {
    await renderOverview();

    for (const title of ['CPU', 'Heap', 'Process memory', 'GC pauses']) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument();
    }
    expect(screen.queryByText('Not in this recording.')).not.toBeInTheDocument();
  });

  it('names the missing data instead of drawing empty charts', async () => {
    await renderOverview({ info: nullInfo(), signals: emptySignals() });

    expect(screen.getAllByText('Not in this recording.')).toHaveLength(4);
    // The banner degrades to n/a, never errors.
    expect(screen.getAllByText('n/a').length).toBeGreaterThan(0);
  });

  it('brushing a chart applies the period and jumps to top methods', async () => {
    const store = await renderOverview();

    const surface = screen.getByTestId('chart-CPU');
    surface.getBoundingClientRect = () =>
      ({ left: 0, width: 100, top: 0, height: 90, right: 100, bottom: 90 }) as DOMRect;

    firePointer(surface, 'pointerdown', 25);
    firePointer(surface, 'pointerup', 75);

    expect(store.filters().time_range_nanos).toEqual([1_000_000_000, 3_000_000_000]);
    expect(store.activeView()).toBe('top-methods');
  });

  it('a plain click moves the cursor without navigating', async () => {
    const store = await renderOverview();

    const surface = screen.getByTestId('chart-Heap');
    surface.getBoundingClientRect = () =>
      ({ left: 0, width: 100, top: 0, height: 90, right: 100, bottom: 90 }) as DOMRect;

    firePointer(surface, 'pointerdown', 50);
    firePointer(surface, 'pointerup', 50);

    expect(store.filters().time_range_nanos).toBeUndefined();
    expect(store.activeView()).toBe('overview');
  });
});
