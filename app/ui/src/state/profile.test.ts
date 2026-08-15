import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { createProfileStore } from './profile';
import type { ProfileSummary, RecentRecording, TopMethods } from '../api/client';

const summary: ProfileSummary = {
  sample_count: 10,
  duration_nanos: 1_000,
  threads: [{ id: 0, name: 'main' }],
  frames: [{ class_name: 'A', method_name: 'b' }],
};

const view: TopMethods = {
  rows: [[0, { self_samples: 10, total_samples: 10 }]],
  total_samples: 10,
};

const recent: RecentRecording = {
  path: '/tmp/rec.jfr',
  size_bytes: 1024,
  last_opened_ms: 1000,
};

function client() {
  return {
    openRecording: vi.fn().mockResolvedValue(summary),
    closeRecording: vi.fn().mockResolvedValue(undefined),
    getTopMethods: vi.fn().mockResolvedValue(view),
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
      expect(api.getTopMethods).toHaveBeenCalledWith({});

      store.setFilters({ threads: [0] });
      await vi.waitFor(() => expect(api.getTopMethods).toHaveBeenCalledWith({ threads: [0] }));
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
      const store = createProfileStore(client());

      await store.open('/a.jfr');
      store.setFilters({ threads: [0] });
      store.setActiveView('overview');

      await store.open('/b.jfr');
      expect(store.filters()).toEqual({});
      expect(store.activeView()).toBe('top-methods');
      dispose();
    });
  });

  it('close drops the recording, its filters and any error', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      const store = createProfileStore(api);

      await store.open('/tmp/rec.jfr');
      store.setFilters({ threads: [0] });
      await store.close();

      expect(api.closeRecording).toHaveBeenCalled();
      expect(store.summary()).toBeUndefined();
      expect(store.openedPath()).toBeUndefined();
      expect(store.filters()).toEqual({});
      expect(store.error()).toBeUndefined();
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
});
