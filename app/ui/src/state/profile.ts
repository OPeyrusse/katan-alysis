// Application state: the open recordings, the cross-cutting filters, and
// the view models fetched from the Rust pipeline. Every filter change flows
// through here and re-queries the backend — views never post-process data.
import { createResource, createSignal, getOwner, runWithOwner, type Accessor } from 'solid-js';
import * as api from '../api/client';
import { selectionLabel } from '../format';
import { uniqueName } from './selections';
import type {
  FlameNode,
  HeatmapGrid,
  MergedCallTree,
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
  { id: 'flamegraph', label: 'Flamegraph', ready: true },
  { id: 'heatmap', label: 'Heatmap', ready: true },
  { id: 'merged-calls', label: 'Merged calls', ready: true },
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

/**
 * All the state and resources scoped to a single open recording. Each slot
 * owns independent SolidJS signals/resources, so two open recordings never
 * leak state into each other and switching back to one restores exactly
 * what it had.
 */
export interface RecordingSlot {
  handle: number;
  path: string;
  summary: Accessor<ProfileSummary>;
  filters: () => RelativeFilters;
  setFilters: (filters: RelativeFilters) => void;
  activeView: () => ViewId;
  setActiveView: (view: ViewId) => void;
  selectedFrame: () => number | undefined;
  selectFrame: (frameId: number) => void;
  selections: () => NamedSelection[];
  appliedSelection: () => string | undefined;
  saveSelection: () => string;
  applySelection: (name: string) => void;
  clearSelection: () => void;
  renameSelection: (name: string, wanted: string) => string;
  deleteSelection: (name: string) => void;
  topMethods: Accessor<TopMethods | undefined>;
  flamegraph: Accessor<FlameNode | undefined>;
  heatmap: Accessor<HeatmapGrid | undefined>;
  mergedCalls: Accessor<MergedCallTree | undefined>;
  density: Accessor<SampleDensity | undefined>;
  info: Accessor<RecordingInfo | undefined>;
  overviewSignals: Accessor<OverviewSignals | undefined>;
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
  /** Method the merged-calls view is focused on, from top-methods or the
   * flamegraph. Unlike the filters, it survives a filter change. */
  selectedFrame: () => number | undefined;
  /** Focuses the merged-calls view on `frameId` and switches to it. */
  selectFrame: (frameId: number) => void;
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
  topMethods: Accessor<TopMethods | undefined>;
  /** Flamegraph tree; re-fetched, like topMethods, on every filter change. */
  flamegraph: Accessor<FlameNode | undefined>;
  /** FlameScope grid; re-fetched, like topMethods, on every filter change. */
  heatmap: Accessor<HeatmapGrid | undefined>;
  /** Callers/callees of `selectedFrame`; `undefined` until one is picked. */
  mergedCalls: Accessor<MergedCallTree | undefined>;
  /** Whole-recording sample density; fetched once per recording. */
  density: Accessor<SampleDensity | undefined>;
  /** JVM/GC/host metadata of the recording; fetched once per recording. */
  info: Accessor<RecordingInfo | undefined>;
  /** Overview signals; fetched once per recording. */
  overviewSignals: Accessor<OverviewSignals | undefined>;
  open: (path: string) => Promise<void>;
  close: () => Promise<void>;
  /** All currently open recordings, in tab/open order. */
  openRecordings: () => { handle: number; path: string; summary: ProfileSummary }[];
  /** Switches the active tab to an already-open recording. */
  selectRecording: (handle: number) => Promise<void>;
  /** Closes a specific (possibly non-active) open recording. */
  closeRecording: (handle: number) => Promise<void>;
  removeRecent: (path: string) => Promise<void>;
  clearRecents: () => Promise<void>;
}

type Client = Pick<
  typeof api,
  | 'openRecording'
  | 'closeRecording'
  | 'activateRecording'
  | 'listOpenRecordings'
  | 'getTopMethods'
  | 'getFlamegraph'
  | 'getHeatmap'
  | 'getMergedCalls'
  | 'getSampleDensity'
  | 'getRecordingInfo'
  | 'getOverviewSignals'
  | 'listRecentRecordings'
  | 'removeRecentRecording'
  | 'clearRecentRecordings'
>;

/**
 * Builds one independent per-recording slot: its own filters, view,
 * selection state and resources, all scoped to `handle`. Nothing here is
 * shared with any other slot, so switching the active handle at the store
 * level is enough to make a different slot's state visible again.
 */
function createRecordingSlot(
  handle: number,
  path: string,
  initialSummary: ProfileSummary,
  client: Client,
): RecordingSlot {
  const [summary] = createSignal<ProfileSummary>(initialSummary);
  const [filters, setFiltersRaw] = createSignal<RelativeFilters>({});
  const [activeView, setActiveView] = createSignal<ViewId>(DEFAULT_VIEW);
  const [selectedFrame, setSelectedFrame] = createSignal<number>();
  const [selections, setSelections] = createSignal<NamedSelection[]>([]);
  const [appliedSelection, setAppliedSelection] = createSignal<string>();

  // Editing the filters detaches the current selection from whatever
  // saved entry it came from: the entry itself is never modified.
  const setFilters = (next: RelativeFilters) => {
    setFiltersRaw(next);
    setAppliedSelection(undefined);
  };

  const [topMethods] = createResource(
    () => ({ filters: filters() }),
    ({ filters }) => client.getTopMethods(handle, filters),
  );

  const [flamegraph] = createResource(
    () => ({ filters: filters() }),
    ({ filters }) => client.getFlamegraph(handle, filters),
  );

  const [heatmap] = createResource(
    () => ({ filters: filters() }),
    ({ filters }) => client.getHeatmap(handle, filters),
  );

  const [mergedCalls] = createResource(
    () => {
      const frameId = selectedFrame();
      return frameId !== undefined ? { frameId, filters: filters() } : undefined;
    },
    ({ frameId, filters }) => client.getMergedCalls(handle, frameId, filters),
  );

  const selectFrame = (frameId: number) => {
    setSelectedFrame(frameId);
    setActiveView('merged-calls');
  };

  const [density] = createResource(
    () => true,
    () => client.getSampleDensity(handle, DENSITY_BUCKETS),
  );

  const [info] = createResource(
    () => true,
    () => client.getRecordingInfo(handle),
  );

  const [overviewSignals] = createResource(
    () => true,
    () => client.getOverviewSignals(handle, OVERVIEW_POINTS),
  );

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

  return {
    handle,
    path,
    summary,
    filters,
    setFilters,
    activeView,
    setActiveView,
    selectedFrame,
    selectFrame,
    selections,
    appliedSelection,
    saveSelection,
    applySelection,
    clearSelection,
    renameSelection,
    deleteSelection,
    topMethods,
    flamegraph,
    heatmap,
    mergedCalls,
    density,
    info,
    overviewSignals,
  };
}

export function createProfileStore(client: Client = api): ProfileStore {
  const [slots, setSlots] = createSignal<RecordingSlot[]>([]);
  const [activeHandle, setActiveHandle] = createSignal<number>();
  const [opening, setOpening] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [recents, setRecents] = createSignal<RecentRecording[]>([]);

  // `open` creates a slot (and its resources) from inside an async
  // callback, after control has already returned past the synchronous
  // portion of whatever root/component owns this store. Capturing the
  // owner here and running slot creation through it keeps those signals
  // and resources properly disposed instead of leaking.
  const owner = getOwner();

  const activeSlot = () => slots().find((s) => s.handle === activeHandle());

  // The list is persisted by the backend; load it once at startup, then
  // track the updated list each command returns.
  void client
    .listRecentRecordings()
    .then(setRecents)
    .catch(() => setRecents([]));

  const open = async (path: string) => {
    // A second open while one is parsing would race the recording state.
    // This guard is workspace-wide, not per-slot: it protects against two
    // concurrent parses racing, not against having multiple recordings open.
    if (opening() !== undefined) return;
    setOpening(path);
    try {
      const { handle, summary } = await client.openRecording(path);
      // Reopening an already-open path reactivates the SAME handle: its
      // filters/selection/view state must be exactly what they were before,
      // since the backend told us nothing changed.
      if (!slots().some((s) => s.handle === handle)) {
        // A new recording starts unfiltered, on the default view, with no
        // saved selections: filters and selections from another slot would
        // silently describe a different data set.
        const slot = runWithOwner(owner, () =>
          createRecordingSlot(handle, path, summary, client),
        ) as RecordingSlot;
        setSlots([...slots(), slot]);
      }
      setActiveHandle(handle);
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

  const closeRecording = async (handle: number) => {
    await client.closeRecording(handle);
    setSlots(slots().filter((s) => s.handle !== handle));
    const stillOpen = await client.listOpenRecordings();
    setActiveHandle(stillOpen.find((r) => r.is_active)?.handle);
  };

  const selectRecording = async (handle: number) => {
    if (!slots().some((s) => s.handle === handle)) return;
    await client.activateRecording(handle);
    setActiveHandle(handle);
  };

  const close = () =>
    activeHandle() === undefined ? Promise.resolve() : closeRecording(activeHandle()!);

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
    summary: () => activeSlot()?.summary(),
    openedPath: () => activeSlot()?.path,
    opening,
    error,
    filters: () => activeSlot()?.filters() ?? {},
    setFilters: (filters) => activeSlot()?.setFilters(filters),
    activeView: () => activeSlot()?.activeView() ?? DEFAULT_VIEW,
    setActiveView: (view) => activeSlot()?.setActiveView(view),
    selectedFrame: () => activeSlot()?.selectedFrame(),
    selectFrame: (frameId) => activeSlot()?.selectFrame(frameId),
    recents,
    topMethods: () => activeSlot()?.topMethods(),
    flamegraph: () => activeSlot()?.flamegraph(),
    heatmap: () => activeSlot()?.heatmap(),
    mergedCalls: () => activeSlot()?.mergedCalls(),
    density: () => activeSlot()?.density(),
    info: () => activeSlot()?.info(),
    overviewSignals: () => activeSlot()?.overviewSignals(),
    selections: () => activeSlot()?.selections() ?? [],
    appliedSelection: () => activeSlot()?.appliedSelection(),
    saveSelection: () => activeSlot()?.saveSelection() ?? '',
    applySelection: (name) => activeSlot()?.applySelection(name),
    clearSelection: () => activeSlot()?.clearSelection(),
    renameSelection: (name, wanted) => activeSlot()?.renameSelection(name, wanted) ?? name,
    deleteSelection: (name) => activeSlot()?.deleteSelection(name),
    open,
    close,
    openRecordings: () =>
      slots().map((s) => ({ handle: s.handle, path: s.path, summary: s.summary() })),
    selectRecording,
    closeRecording,
    removeRecent,
    clearRecents,
  };
}
