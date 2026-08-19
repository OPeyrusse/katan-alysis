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

export function openRecording(path: string): Promise<ProfileSummary> {
  return invoke('open_recording', { path });
}

export function closeRecording(): Promise<void> {
  return invoke('close_recording');
}

export function getTopMethods(filters: RelativeFilters): Promise<TopMethods> {
  return invoke('get_top_methods', { filters });
}

export function getFlamegraph(filters: RelativeFilters): Promise<FlameNode> {
  return invoke('get_flamegraph', { filters });
}

export function getSampleDensity(buckets: number): Promise<SampleDensity> {
  return invoke('get_sample_density', { buckets });
}

export function getRecordingInfo(): Promise<RecordingInfo> {
  return invoke('get_recording_info');
}

export function getOverviewSignals(maxPoints: number): Promise<OverviewSignals> {
  return invoke('get_overview_signals', { maxPoints });
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
