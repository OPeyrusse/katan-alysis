// Typed wrappers over the Tauri IPC. Field names mirror the Rust structs
// (snake_case) exactly; timestamps are nanoseconds relative to the start of
// the recording (absolute epoch nanos would overflow JS safe integers).
import { invoke } from '@tauri-apps/api/core';

export interface Frame {
  class_name: string;
  method_name: string;
}

export interface ThreadInfo {
  id: number;
  name: string;
}

export interface ProfileSummary {
  sample_count: number;
  duration_nanos: number;
  threads: ThreadInfo[];
  /** Whole-recording sample count per thread, indexed like `threads`. */
  thread_sample_counts: number[];
  frames: Frame[];
}

/**
 * Sample counts over uniform time buckets; bucket `i` covers relative
 * nanoseconds `[i * bucket_nanos, (i + 1) * bucket_nanos)`.
 */
export interface SampleDensity {
  bucket_nanos: number;
  counts: number[];
}

export interface MethodStats {
  self_samples: number;
  total_samples: number;
}

export interface TopMethods {
  rows: [number, MethodStats][];
  total_samples: number;
}

/**
 * One node of the flamegraph tree; `frame` is `null` only for the
 * synthetic root above every stack. Children are pre-sorted by
 * decreasing `samples`.
 */
export interface FlameNode {
  frame: number | null;
  samples: number;
  children: FlameNode[];
}

/**
 * FlameScope-style density grid: `columns[i][j]` is the sample count of row
 * `j` of column `i`. Columns always span the whole recording — column 0
 * sits at recording-relative nanosecond 0 — so a cell's time only depends
 * on `column_nanos`/`row_nanos`, never on the current filters.
 */
export interface HeatmapGrid {
  column_nanos: number;
  row_nanos: number;
  rows: number;
  columns: number[][];
  max_count: number;
  /** Same shape as `columns`, counted with the thread filter only — the
   * time range never narrows it, so it still shades the part of the grid
   * outside the current time selection. */
  context_columns: number[][];
  context_max_count: number;
}

/**
 * Callers and callees merged around one focus method: both trees are
 * rooted at `focus` (never `null`, unlike `FlameNode`'s synthetic root),
 * with the same `samples` — the frame's total across the selection.
 */
export interface MergedCallTree {
  focus: number;
  callers: FlameNode;
  callees: FlameNode;
}

// An empty selection is not a filter: an empty thread list, or a range
// holding no instant, widens back to the whole recording. The UI can send
// the selection as-is — it never has to special-case "nothing selected".
export interface RelativeFilters {
  threads?: number[] | null;
  time_range_nanos?: [number, number] | null;
}

// One entry of the persisted recents list, most recent first. `exists`
// is checked at list time: a file deleted since its last open shows as
// missing instead of failing when clicked.
export interface RecentRecording {
  path: string;
  size_bytes: number;
  last_opened_ms: number;
  exists: boolean;
}

// A JVM flag captured at recording start, with where its value came from
// ('Command line', 'Ergonomic', 'Default', ...).
export interface UnsignedFlag {
  value: number;
  origin: string;
}

export interface BooleanFlag {
  value: boolean;
  origin: string;
}

// What the recording says about the JVM that produced it; every field may
// be null — async-profiler recordings carry no metadata at all.
export interface RecordingInfo {
  jvm_name: string | null;
  jvm_version: string | null;
  young_collector: string | null;
  old_collector: string | null;
  heap_max_bytes: number | null;
  os_version: string | null;
  cpu_cores: number | null;
  hw_threads: number | null;
  physical_memory_bytes: number | null;
  xmx: UnsignedFlag | null;
  xms: UnsignedFlag | null;
  max_direct_memory: UnsignedFlag | null;
  debug_non_safepoints: BooleanFlag | null;
}

// One point of a sampled signal; timestamps are recording-relative nanos.
export interface TimePoint {
  ts_nanos: number;
  value: number;
}

export interface GcPause {
  ts_nanos: number;
  duration_nanos: number;
  name: string;
  cause: string;
}

// The overview signals, downsampled server-side; empty arrays when the
// recording does not carry the corresponding events.
export interface OverviewSignals {
  cpu_jvm_user: TimePoint[];
  cpu_jvm_system: TimePoint[];
  cpu_machine_total: TimePoint[];
  heap_used_bytes: TimePoint[];
  heap_committed_bytes: TimePoint[];
  rss_bytes: TimePoint[];
  gc_pauses: GcPause[];
}

// A recording just opened (or reactivated) by the backend, addressed from
// here on by its opaque `handle`.
export interface OpenedRecording {
  handle: number;
  summary: ProfileSummary;
}

// One entry of the open-recordings list, in tab/open order.
export interface OpenRecordingView {
  handle: number;
  is_active: boolean;
  summary: ProfileSummary;
}

export function openRecording(path: string): Promise<OpenedRecording> {
  return invoke('open_recording', { path });
}

export function closeRecording(handle: number): Promise<void> {
  return invoke('close_recording', { handle });
}

export function activateRecording(handle: number): Promise<void> {
  return invoke('activate_recording', { handle });
}

export function listOpenRecordings(): Promise<OpenRecordingView[]> {
  return invoke('list_open_recordings');
}

export function getTopMethods(handle: number, filters: RelativeFilters): Promise<TopMethods> {
  return invoke('get_top_methods', { handle, filters });
}

export function getFlamegraph(handle: number, filters: RelativeFilters): Promise<FlameNode> {
  return invoke('get_flamegraph', { handle, filters });
}

export function getHeatmap(handle: number, filters: RelativeFilters): Promise<HeatmapGrid> {
  return invoke('get_heatmap', { handle, filters });
}

export function getMergedCalls(
  handle: number,
  frameId: number,
  filters: RelativeFilters,
): Promise<MergedCallTree> {
  return invoke('get_merged_calls', { handle, frameId, filters });
}

export function getSampleDensity(handle: number, buckets: number): Promise<SampleDensity> {
  return invoke('get_sample_density', { handle, buckets });
}

export function getRecordingInfo(handle: number): Promise<RecordingInfo> {
  return invoke('get_recording_info', { handle });
}

export function getOverviewSignals(
  handle: number,
  maxPoints: number,
): Promise<OverviewSignals> {
  return invoke('get_overview_signals', { handle, maxPoints });
}

export function listRecentRecordings(): Promise<RecentRecording[]> {
  return invoke('list_recent_recordings');
}

export function removeRecentRecording(path: string): Promise<RecentRecording[]> {
  return invoke('remove_recent_recording', { path });
}

export function clearRecentRecordings(): Promise<RecentRecording[]> {
  return invoke('clear_recent_recordings');
}

export function frameLabel(frames: Frame[], id: number): string {
  const frame = frames[id];
  return frame ? `${frame.class_name}.${frame.method_name}` : `#${id}`;
}
