import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { createProfileStore } from './profile';
import type { ProfileSummary, TopMethods } from '../api/client';

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

function client() {
  return {
    openRecording: vi.fn().mockResolvedValue(summary),
    getTopMethods: vi.fn().mockResolvedValue(view),
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

  it('loads the summary then fetches views, and refetches on filter change', async () => {
    await createRoot(async (dispose) => {
      const api = client();
      const store = createProfileStore(api);

      await store.open('/tmp/rec.jfr');
      expect(store.summary()).toEqual(summary);
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
});
