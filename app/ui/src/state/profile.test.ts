import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { createProfileStore } from './profile';
import type {
  FlameNode,
  HeatmapGrid,
  MergedCallTree,
  ProfileSummary,
  RecentRecording,
  TopMethods,
} from '../api/client';
import { emptySignals, nullInfo } from '../test/fixtures';

const summary: ProfileSummary = {
  sample_count: 10,
  duration_nanos: 1_000,
  threads: [{ id: 0, name: 'main' }],
  thread_sample_counts: [10],
  frames: [{ class_name: 'A', method_name: 'b' }],
};

const view: TopMethods = {
  rows: [[0, { self_samples: 10, total_samples: 10 }]],
  total_samples: 10,
};

const flame: FlameNode = {
  frame: null,
  samples: 10,
  children: [{ frame: 0, samples: 10, children: [] }],
};

const heatmap: HeatmapGrid = {
  column_nanos: 1_000_000_000,
  row_nanos: 20_000_000,
  rows: 1,
  columns: [[10]],
  max_count: 10,
};

const merged: MergedCallTree = {
  focus: 0,
  callers: { frame: 0, samples: 10, children: [] },
  callees: { frame: 0, samples: 10, children: [] },
};

const recent: RecentRecording = {
  path: '/tmp/rec.jfr',
  size_bytes: 1024,
  last_opened_ms: 1000,
  exists: true,
};

const density = { bucket_nanos: 100, counts: [4, 6] };

function client() {
  return {
    openRecording: vi.fn().mockResolvedValue({ handle: 1, summary }),
    closeRecording: vi.fn().mockResolvedValue(undefined),
    activateRecording: vi.fn().mockResolvedValue(undefined),
    listOpenRecordings: vi.fn().mockResolvedValue([]),
    getTopMethods: vi.fn().mockResolvedValue(view),
    getFlamegraph: vi.fn().mockResolvedValue(flame),
    getHeatmap: vi.fn().mockResolvedValue(heatmap),
    getMergedCalls: vi.fn().mockResolvedValue(merged),
    getSampleDensity: vi.fn().mockResolvedValue(density),
    getRecordingInfo: vi.fn().mockResolvedValue(nullInfo()),
    getOverviewSignals: vi.fn().mockResolvedValue(emptySignals()),
    listRecentRecordings: vi.fn().mockResolvedValue([recent]),
    removeRecentRecording: vi.fn().mockResolvedValue([]),
    clearRecentRecordings: vi.fn().mockResolvedValue([]),
  };
}

describe('createProfileStore', () => {
  it('does not query views before a recording is loaded', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      const store = createProfileStore(api);
      expect(store.summary()).toBeUndefined();
      expect(store.topMethods()).toBeUndefined();
      expect(api.getTopMethods).not.toHaveBeenCalled();
      dispose();
    });
  });

  it('loads the persisted recents at startup', async () => {
    await createRoot(async (dispose) => {
      const store = createProfileStore(client());
      await vi.waitFor(() => expect(store.recents()).toEqual([recent]));
      dispose();
    });
  });

  it('loads the summary then fetches views, and refetches on filter change', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      const store = createProfileStore(api);

      await store.open('/tmp/rec.jfr');
      expect(store.summary()).toEqual(summary);
      expect(store.openedPath()).toBe('/tmp/rec.jfr');
      await vi.waitFor(() => expect(store.topMethods()).toEqual(view));
      expect(api.getTopMethods).toHaveBeenCalledWith(1, {});

      store.setFilters({ threads: [0] });
      await vi.waitFor(() =>
        expect(api.getTopMethods).toHaveBeenCalledWith(1, { threads: [0] }),
      );
      dispose();
    });
  });

  it('fetches the heatmap and refetches it on filter change', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      const store = createProfileStore(api);

      await store.open('/tmp/rec.jfr');
      await vi.waitFor(() => expect(store.heatmap()).toEqual(heatmap));
      expect(api.getHeatmap).toHaveBeenCalledWith(1, {});

      store.setFilters({ threads: [0] });
      await vi.waitFor(() => expect(api.getHeatmap).toHaveBeenCalledWith(1, { threads: [0] }));
      dispose();
    });
  });

  it('does not fetch merged calls before a method is selected', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      const store = createProfileStore(api);

      await store.open('/tmp/rec.jfr');
      expect(store.selectedFrame()).toBeUndefined();
      expect(store.mergedCalls()).toBeUndefined();
      expect(api.getMergedCalls).not.toHaveBeenCalled();
      dispose();
    });
  });

  it('selecting a frame fetches merged calls and switches to that view', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      const store = createProfileStore(api);

      await store.open('/tmp/rec.jfr');
      store.selectFrame(0);

      expect(store.selectedFrame()).toBe(0);
      expect(store.activeView()).toBe('merged-calls');
      await vi.waitFor(() => expect(store.mergedCalls()).toEqual(merged));
      expect(api.getMergedCalls).toHaveBeenCalledWith(1, 0, {});

      store.setFilters({ threads: [0] });
      await vi.waitFor(() =>
        expect(api.getMergedCalls).toHaveBeenCalledWith(1, 0, { threads: [0] }),
      );
      dispose();
    });
  });

  it('selecting a frame survives once selected, but dies with the recording', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      api.openRecording.mockImplementation((path: string) =>
        Promise.resolve({ handle: path === '/a.jfr' ? 1 : 2, summary }),
      );
      const store = createProfileStore(api);

      await store.open('/a.jfr');
      store.selectFrame(0);
      store.setActiveView('top-methods');
      expect(store.selectedFrame()).toBe(0);

      await store.open('/b.jfr');
      expect(store.selectedFrame()).toBeUndefined();
      dispose();
    });
  });

  it('keeps the previous recording on failed open', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      api.openRecording.mockRejectedValueOnce('boom');
      const store = createProfileStore(api);

      await store.open('/bad.jfr');
      expect(store.error()).toBe('boom');
      expect(store.summary()).toBeUndefined();

      await store.open('/good.jfr');
      expect(store.error()).toBeUndefined();
      expect(store.summary()).toEqual(summary);
      dispose();
    });
  });

  it('resets filters and lands on the default view when opening', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      api.openRecording.mockImplementation((path: string) =>
        Promise.resolve({ handle: path === '/a.jfr' ? 1 : 2, summary }),
      );
      const store = createProfileStore(api);

      await store.open('/a.jfr');
      store.setFilters({ threads: [0] });
      store.setActiveView('top-methods');

      await store.open('/b.jfr');
      expect(store.filters()).toEqual({});
      expect(store.activeView()).toBe('overview');
      dispose();
    });
  });

  it('close drops the recording, its filters and any error', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      api.listOpenRecordings.mockResolvedValue([]);
      const store = createProfileStore(api);

      await store.open('/tmp/rec.jfr');
      store.setFilters({ threads: [0] });
      store.selectFrame(0);
      await store.close();

      expect(api.closeRecording).toHaveBeenCalledWith(1);
      expect(store.summary()).toBeUndefined();
      expect(store.openedPath()).toBeUndefined();
      expect(store.filters()).toEqual({});
      expect(store.selectedFrame()).toBeUndefined();
      expect(store.error()).toBeUndefined();
      dispose();
    });
  });

  it('saves the current selection under its default name', async () => {
    await createRoot(async (dispose) => {
      const store = createProfileStore(client());
      await store.open('/a.jfr');

      store.setFilters({ threads: [0], time_range_nanos: [45_000_000_000, 130_000_000_000] });
      const name = store.saveSelection();

      expect(name).toBe('0:45–2:10 · 1 thread');
      expect(store.selections()).toEqual([
        { name, filters: { threads: [0], time_range_nanos: [45_000_000_000, 130_000_000_000] } },
      ]);
      expect(store.appliedSelection()).toBe(name);
      dispose();
    });
  });

  it('suffixes conflicting names', async () => {
    await createRoot(async (dispose) => {
      const store = createProfileStore(client());
      await store.open('/a.jfr');

      store.setFilters({ threads: [0] });
      expect(store.saveSelection()).toBe('whole recording · 1 thread');
      store.setFilters({ threads: [0] });
      expect(store.saveSelection()).toBe('whole recording · 1 thread (2)');
      store.setFilters({ threads: [0] });
      expect(store.saveSelection()).toBe('whole recording · 1 thread (3)');
      dispose();
    });
  });

  it('reapplies a saved selection and detaches on edit', async () => {
    await createRoot(async (dispose) => {
      const store = createProfileStore(client());
      await store.open('/a.jfr');

      store.setFilters({ threads: [0] });
      const name = store.saveSelection();
      store.clearSelection();
      expect(store.filters()).toEqual({});
      expect(store.appliedSelection()).toBeUndefined();

      store.applySelection(name);
      expect(store.filters()).toEqual({ threads: [0] });
      expect(store.appliedSelection()).toBe(name);

      // Any filter edit detaches the applied selection; the saved entry
      // itself must stay untouched.
      store.setFilters({ threads: [0, 1] });
      expect(store.appliedSelection()).toBeUndefined();
      expect(store.selections()[0].filters).toEqual({ threads: [0] });
      dispose();
    });
  });

  it('renames with the same conflict rule and keeps the application', async () => {
    await createRoot(async (dispose) => {
      const store = createProfileStore(client());
      await store.open('/a.jfr');

      store.setFilters({ threads: [0] });
      store.saveSelection();
      store.setFilters({ threads: [1] });
      const second = store.saveSelection();

      expect(store.renameSelection(second, 'peak load')).toBe('peak load');
      expect(store.appliedSelection()).toBe('peak load');
      // Renaming into a taken name gets suffixed.
      expect(store.renameSelection('peak load', 'whole recording · 1 thread')).toBe(
        'whole recording · 1 thread (2)',
      );
      // A blank rename is ignored.
      expect(store.renameSelection('whole recording · 1 thread', '  ')).toBe(
        'whole recording · 1 thread',
      );
      dispose();
    });
  });

  it('deleting a selection keeps the filters it produced', async () => {
    await createRoot(async (dispose) => {
      const store = createProfileStore(client());
      await store.open('/a.jfr');

      store.setFilters({ threads: [0] });
      const name = store.saveSelection();
      store.deleteSelection(name);

      expect(store.selections()).toEqual([]);
      expect(store.appliedSelection()).toBeUndefined();
      expect(store.filters()).toEqual({ threads: [0] });
      dispose();
    });
  });

  it('selections die with the recording', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      api.listOpenRecordings.mockResolvedValue([]);
      api.openRecording.mockImplementation((path: string) =>
        Promise.resolve({ handle: path === '/a.jfr' ? 1 : 2, summary }),
      );
      const store = createProfileStore(api);

      await store.open('/a.jfr');
      store.setFilters({ threads: [0] });
      store.saveSelection();

      await store.close();
      expect(store.selections()).toEqual([]);

      await store.open('/a.jfr');
      store.setFilters({ threads: [0] });
      store.saveSelection();
      await store.open('/b.jfr');
      expect(store.selections()).toEqual([]);
      expect(store.appliedSelection()).toBeUndefined();
      dispose();
    });
  });

  it('tracks the recents list across open, remove and clear', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      const updated = [{ ...recent, path: '/other.jfr' }];
      api.listRecentRecordings
        .mockResolvedValueOnce([]) // startup
        .mockResolvedValueOnce(updated); // after open
      const store = createProfileStore(api);

      await store.open('/other.jfr');
      expect(store.recents()).toEqual(updated);

      api.removeRecentRecording.mockResolvedValue([]);
      await store.removeRecent('/other.jfr');
      expect(api.removeRecentRecording).toHaveBeenCalledWith('/other.jfr');
      expect(store.recents()).toEqual([]);

      await store.clearRecents();
      expect(api.clearRecentRecordings).toHaveBeenCalled();
      expect(store.recents()).toEqual([]);
      dispose();
    });
  });

  it('keeps two opened recordings independent, and restores state on switch back', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      api.openRecording.mockImplementation((path: string) =>
        Promise.resolve({ handle: path === '/a.jfr' ? 1 : 2, summary }),
      );
      const store = createProfileStore(api);

      await store.open('/a.jfr');
      store.setFilters({ threads: [0] });
      expect(store.filters()).toEqual({ threads: [0] });

      await store.open('/b.jfr');
      expect(store.openedPath()).toBe('/b.jfr');
      expect(store.filters()).toEqual({});

      await store.selectRecording(1);
      expect(store.openedPath()).toBe('/a.jfr');
      expect(store.filters()).toEqual({ threads: [0] });
      dispose();
    });
  });

  it('reopening an already-open path reactivates the same slot without resetting it', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      api.openRecording.mockResolvedValue({ handle: 1, summary });
      const store = createProfileStore(api);

      await store.open('/a.jfr');
      store.setFilters({ threads: [0] });
      store.selectFrame(0);

      await store.open('/a.jfr');
      expect(store.filters()).toEqual({ threads: [0] });
      expect(store.selectedFrame()).toBe(0);
      expect(store.openRecordings()).toHaveLength(1);
      dispose();
    });
  });

  it('openRecordings reflects both open slots after opening two paths', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      api.openRecording.mockImplementation((path: string) =>
        Promise.resolve({ handle: path === '/a.jfr' ? 1 : 2, summary }),
      );
      const store = createProfileStore(api);

      await store.open('/a.jfr');
      await store.open('/b.jfr');

      expect(store.openRecordings()).toEqual([
        { handle: 1, path: '/a.jfr', summary },
        { handle: 2, path: '/b.jfr', summary },
      ]);
      dispose();
    });
  });

  it('closing a non-active tab leaves the active one untouched', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      api.openRecording.mockImplementation((path: string) =>
        Promise.resolve({ handle: path === '/a.jfr' ? 1 : 2, summary }),
      );
      const store = createProfileStore(api);

      await store.open('/a.jfr');
      await store.open('/b.jfr');
      store.setFilters({ threads: [1] });
      expect(store.openedPath()).toBe('/b.jfr');

      api.listOpenRecordings.mockResolvedValue([
        { handle: 2, is_active: true, summary },
      ]);
      await store.closeRecording(1);

      expect(api.closeRecording).toHaveBeenCalledWith(1);
      expect(store.openedPath()).toBe('/b.jfr');
      expect(store.filters()).toEqual({ threads: [1] });
      expect(store.openRecordings()).toEqual([{ handle: 2, path: '/b.jfr', summary }]);
      dispose();
    });
  });
});
