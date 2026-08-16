// Application state: the loaded recording, the cross-cutting filters, and
// the view models fetched from the Rust pipeline. Every filter change flows
// through here and re-queries the backend — views never post-process data.
import { createResource, createSignal, type Resource } from 'solid-js';
import * as api from '../api/client';
import { selectionLabel } from '../format';
import { uniqueName } from './selections';
import type {
  OverviewSignals,
  ProfileSummary,
  RecentRecording,
  RecordingInfo,
  RelativeFilters,
  SampleDensity,
  TopMethods,
} from '../api/client';

/** Resolution of the timeline density strip, in buckets. */
const DENSITY_BUCKETS = 240;

/** Maximum points per overview series; the charts are ~600 px wide. */
const OVERVIEW_POINTS = 600;

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
export const DEFAULT_VIEW: ViewId = 'overview';

/**
 * A selection the analyst saved under a name. In-memory only: the list
 * lives and dies with the recording it narrows.
 */
export interface NamedSelection {
  name: string;
  filters: RelativeFilters;
}

export interface ProfileStore {
  summary: () => ProfileSummary | undefined;
  /** Path of the recording behind `summary`, for the window chrome. */
  openedPath: () => string | undefined;
  /** Path currently being opened; large files take a while to parse. */
  opening: () => string | undefined;
  error: () => string | undefined;
  filters: () => RelativeFilters;
  setFilters: (filters: RelativeFilters) => void;
  activeView: () => ViewId;
  setActiveView: (view: ViewId) => void;
  /** Saved selections of the current recording, in save order. */
  selections: () => NamedSelection[];
  /** Name of the saved selection the current filters came from, if any. */
  appliedSelection: () => string | undefined;
  /** Saves the current selection; returns its (possibly suffixed) name. */
  saveSelection: () => string;
  applySelection: (name: string) => void;
  /** Back to no selection at all: every thread, the whole recording. */
  clearSelection: () => void;
  /** Renames a saved selection; returns the name actually taken. */
  renameSelection: (name: string, wanted: string) => string;
  deleteSelection: (name: string) => void;
  recents: () => RecentRecording[];
  topMethods: Resource<TopMethods | undefined>;
  /** Whole-recording sample density; fetched once per recording. */
  density: Resource<SampleDensity | undefined>;
  /** JVM/GC/host metadata of the recording; fetched once per recording. */
  info: Resource<RecordingInfo | undefined>;
  /** Overview signals; fetched once per recording. */
  overviewSignals: Resource<OverviewSignals | undefined>;
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
  | 'getSampleDensity'
  | 'getRecordingInfo'
  | 'getOverviewSignals'
  | 'listRecentRecordings'
  | 'removeRecentRecording'
  | 'clearRecentRecordings'
>;

export function createProfileStore(client: Client = api): ProfileStore {
  const [summary, setSummary] = createSignal<ProfileSummary>();
  const [openedPath, setOpenedPath] = createSignal<string>();
  const [opening, setOpening] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [filters, setFiltersRaw] = createSignal<RelativeFilters>({});
  const [activeView, setActiveView] = createSignal<ViewId>(DEFAULT_VIEW);
  const [recents, setRecents] = createSignal<RecentRecording[]>([]);
  const [selections, setSelections] = createSignal<NamedSelection[]>([]);
  const [appliedSelection, setAppliedSelection] = createSignal<string>();

  // Editing the filters detaches the current selection from whatever
  // saved entry it came from: the entry itself is never modified.
  const setFilters = (next: RelativeFilters) => {
    setFiltersRaw(next);
    setAppliedSelection(undefined);
  };

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

  const [density] = createResource(
    () => summary(),
    () => client.getSampleDensity(DENSITY_BUCKETS),
  );

  const [info] = createResource(
    () => summary(),
    () => client.getRecordingInfo(),
  );

  const [overviewSignals] = createResource(
    () => summary(),
    () => client.getOverviewSignals(OVERVIEW_POINTS),
  );

  const open = async (path: string) => {
    // A second open while one is parsing would race the recording state.
    if (opening() !== undefined) return;
    setOpening(path);
    try {
      const opened = await client.openRecording(path);
      setSummary(opened);
      setOpenedPath(path);
      // A new recording starts unfiltered, on the default view, with no
      // saved selections: filters and selections from the previous one
      // would silently describe a different data set.
      setFilters({});
      setSelections([]);
      setActiveView(DEFAULT_VIEW);
      setError(undefined);
      setRecents(await client.listRecentRecordings());
    } catch (e) {
      // A failed open never costs the analyst the recording they were
      // reading: only the error changes.
      setError(String(e));
    } finally {
      setOpening(undefined);
    }
  };

  const close = async () => {
    await client.closeRecording();
    setSummary(undefined);
    setOpenedPath(undefined);
    setFilters({});
    setSelections([]);
    setError(undefined);
  };

  const saveSelection = () => {
    const current = filters();
    const name = uniqueName(
      selectionLabel(current.time_range_nanos ?? null, current.threads?.length ?? null),
      selections().map((s) => s.name),
    );
    setSelections([...selections(), { name, filters: { ...current } }]);
    setAppliedSelection(name);
    return name;
  };

  const applySelection = (name: string) => {
    const saved = selections().find((s) => s.name === name);
    if (!saved) return;
    setFiltersRaw({ ...saved.filters });
    setAppliedSelection(name);
  };

  const clearSelection = () => {
    setFiltersRaw({});
    setAppliedSelection(undefined);
  };

  const renameSelection = (name: string, wanted: string) => {
    const trimmed = wanted.trim();
    if (trimmed === '' || trimmed === name) return name;
    const others = selections().filter((s) => s.name !== name).map((s) => s.name);
    const taken = uniqueName(trimmed, others);
    setSelections(selections().map((s) => (s.name === name ? { ...s, name: taken } : s)));
    if (appliedSelection() === name) setAppliedSelection(taken);
    return taken;
  };

  const deleteSelection = (name: string) => {
    setSelections(selections().filter((s) => s.name !== name));
    // The filters the entry produced stay in place; they are simply
    // anonymous again.
    if (appliedSelection() === name) setAppliedSelection(undefined);
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
    opening,
    error,
    filters,
    setFilters,
    activeView,
    setActiveView,
    recents,
    topMethods,
    density,
    info,
    overviewSignals,
    selections,
    appliedSelection,
    saveSelection,
    applySelection,
    clearSelection,
    renameSelection,
    deleteSelection,
    open,
    close,
    removeRecent,
    clearRecents,
  };
}
