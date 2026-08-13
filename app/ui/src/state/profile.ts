// Application state: the loaded recording, the cross-cutting filters, and
// the view models fetched from the Rust pipeline. Every filter change flows
// through here and re-queries the backend — views never post-process data.
import { createResource, createSignal, type Resource } from 'solid-js';
import * as api from '../api/client';
import type { ProfileSummary, RelativeFilters, TopMethods } from '../api/client';

export interface ProfileStore {
  summary: () => ProfileSummary | undefined;
  error: () => string | undefined;
  filters: () => RelativeFilters;
  setFilters: (filters: RelativeFilters) => void;
  topMethods: Resource<TopMethods | undefined>;
  open: (path: string) => Promise<void>;
}

type Client = Pick<typeof api, 'openRecording' | 'getTopMethods'>;

export function createProfileStore(client: Client = api): ProfileStore {
  const [summary, setSummary] = createSignal<ProfileSummary>();
  const [error, setError] = createSignal<string>();
  const [filters, setFilters] = createSignal<RelativeFilters>({});

  const [topMethods] = createResource(
    () => (summary() ? { filters: filters() } : undefined),
    ({ filters }) => client.getTopMethods(filters),
  );

  const open = async (path: string) => {
    try {
      setSummary(await client.openRecording(path));
      setFilters({});
      setError(undefined);
    } catch (e) {
      setError(String(e));
    }
  };

  return { summary, error, filters, setFilters, topMethods, open };
}
