// Application state: the loaded recording, the cross-cutting filters, and
// the view models fetched from the Rust pipeline. Every filter change flows
// through here and re-queries the backend — views never post-process data.
import { createResource, createSignal, type Resource } from 'solid-js';
import * as api from '../api/client';
import type {
  ProfileSummary,
  RecentRecording,
  RelativeFilters,
  TopMethods,
} from '../api/client';

/** The specialized views the sidebar navigates between. */
export const VIEWS = [
  { id: 'overview', label: 'Overview', ready: true },
  { id: 'top-methods', label: 'Top methods', ready: true },
  { id: 'flamegraph', label: 'Flamegraph', ready: false },
  { id: 'heatmap', label: 'Heatmap', ready: false },
  { id: 'merged-calls', label: 'Merged calls', ready: false },
  { id: 'gc', label: 'GC', ready: false },
] as const;

export type ViewId = (typeof VIEWS)[number]['id'];

/** Where a freshly opened recording lands. */
export const DEFAULT_VIEW: ViewId = 'top-methods';

export interface ProfileStore {
  summary: () => ProfileSummary | undefined;
  /** Path of the recording behind `summary`, for the window chrome. */
  openedPath: () => string | undefined;
  error: () => string | undefined;
  filters: () => RelativeFilters;
  setFilters: (filters: RelativeFilters) => void;
  activeView: () => ViewId;
  setActiveView: (view: ViewId) => void;
  recents: () => RecentRecording[];
  topMethods: Resource<TopMethods | undefined>;
  open: (path: string) => Promise<void>;
  close: () => Promise<void>;
  removeRecent: (path: string) => Promise<void>;
  clearRecents: () => Promise<void>;
}

type Client = Pick<
  typeof api,
  | 'openRecording'
  | 'closeRecording'
  | 'getTopMethods'
  | 'listRecentRecordings'
  | 'removeRecentRecording'
  | 'clearRecentRecordings'
>;

export function createProfileStore(client: Client = api): ProfileStore {
  const [summary, setSummary] = createSignal<ProfileSummary>();
  const [openedPath, setOpenedPath] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [filters, setFilters] = createSignal<RelativeFilters>({});
  const [activeView, setActiveView] = createSignal<ViewId>(DEFAULT_VIEW);
  const [recents, setRecents] = createSignal<RecentRecording[]>([]);

  // The list is persisted by the backend; load it once at startup, then
  // track the updated list each command returns.
  void client
    .listRecentRecordings()
    .then(setRecents)
    .catch(() => setRecents([]));

  const [topMethods] = createResource(
    () => (summary() ? { filters: filters() } : undefined),
    ({ filters }) => client.getTopMethods(filters),
  );

  const open = async (path: string) => {
    try {
      const opened = await client.openRecording(path);
      setSummary(opened);
      setOpenedPath(path);
      // A new recording starts unfiltered, on the default view: filters
      // from the previous one would silently narrow a different data set.
      setFilters({});
      setActiveView(DEFAULT_VIEW);
      setError(undefined);
      setRecents(await client.listRecentRecordings());
    } catch (e) {
      // A failed open never costs the analyst the recording they were
      // reading: only the error changes.
      setError(String(e));
    }
  };

  const close = async () => {
    await client.closeRecording();
    setSummary(undefined);
    setOpenedPath(undefined);
    setFilters({});
    setError(undefined);
  };

  const removeRecent = async (path: string) => {
    try {
      setRecents(await client.removeRecentRecording(path));
    } catch (e) {
      setError(String(e));
    }
  };

  const clearRecents = async () => {
    try {
      setRecents(await client.clearRecentRecordings());
    } catch (e) {
      setError(String(e));
    }
  };

  return {
    summary,
    openedPath,
    error,
    filters,
    setFilters,
    activeView,
    setActiveView,
    recents,
    topMethods,
    open,
    close,
    removeRecent,
    clearRecents,
  };
}
