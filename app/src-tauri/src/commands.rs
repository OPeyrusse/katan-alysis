//! IPC commands. Each `#[tauri::command]` is a thin wrapper over a plain
//! function taking `&RecordingState`, so the logic is unit-testable without
//! a webview.
//!
//! Timestamps cross the IPC boundary as nanoseconds *relative to the start
//! of the recording*: absolute epoch nanoseconds exceed JavaScript's safe
//! integer range, relative ones don't.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use jfr_model::{
    Filters, FlameNode, Frame, FrameId, GcPause, HeatmapGrid, MergedCallTree, Profile,
    RecordingInfo, SampleDensity, ThreadId, ThreadInfo, TimePoint, TopMethods,
};
use serde::{Deserialize, Serialize};

use crate::recents::{self, RecentRecording};

/// A stable identifier for one open recording, minted when it's opened and
/// valid until it's closed. The UI addresses recordings by this rather than
/// by path so re-opening an already-open path can resolve back to the same
/// tab. Serialized as a bare integer on the IPC boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RecordingHandle(pub u64);

/// One loaded recording: the path it was opened from (so re-opening it can
/// be recognised), its size at open time (so reactivating it doesn't need
/// the file to still be readable), and its parsed profile.
struct OpenEntry {
    path: String,
    size_bytes: u64,
    profile: Profile,
}

/// Every recording currently open, in tab order (insertion order), plus
/// which one is active. Filters, focus and saved selections stay client
/// side and never enter this struct.
#[derive(Default)]
struct Recordings {
    next_handle: u64,
    open: Vec<(RecordingHandle, OpenEntry)>,
    active: Option<RecordingHandle>,
}

impl Recordings {
    fn allocate_handle(&mut self) -> RecordingHandle {
        let handle = RecordingHandle(self.next_handle);
        self.next_handle += 1;
        handle
    }

    fn position_of_handle(&self, handle: RecordingHandle) -> Option<usize> {
        self.open.iter().position(|(h, _)| *h == handle)
    }

    fn position_of_path(&self, path: &str) -> Option<usize> {
        self.open.iter().position(|(_, e)| e.path == path)
    }

    fn entry(&self, handle: RecordingHandle) -> Option<&OpenEntry> {
        self.open.iter().find(|(h, _)| *h == handle).map(|(_, e)| e)
    }

    fn profile(&self, handle: RecordingHandle) -> Result<&Profile, String> {
        self.entry(handle)
            .map(|e| &e.profile)
            .ok_or_else(|| "no recording loaded".to_string())
    }
}

/// Every recording currently open in the application, and which one is
/// active.
#[derive(Default)]
pub struct RecordingState(Mutex<Recordings>);

/// Where the recents list is persisted; resolved once at startup from the
/// app config directory.
pub struct RecentsState(pub PathBuf);

/// What the UI needs up front: dictionaries and global bounds. Views then
/// reference frames and threads by index.
#[derive(Debug, Clone, Serialize)]
pub struct ProfileSummary {
    pub sample_count: u64,
    /// Recording span in nanoseconds; UI timestamps live in `[0, duration]`.
    pub duration_nanos: i64,
    pub threads: Vec<ThreadInfo>,
    /// Whole-recording sample count per thread, indexed like `threads`.
    /// The thread panel orders by it; it never changes with the selection.
    pub thread_sample_counts: Vec<u64>,
    pub frames: Vec<Frame>,
}

/// The result of successfully opening (or reactivating) a recording: its
/// handle, for every subsequent call, and its summary.
#[derive(Debug, Clone, Serialize)]
pub struct OpenedRecording {
    pub handle: RecordingHandle,
    pub summary: ProfileSummary,
}

/// One entry in the open-recordings list, as the tab strip consumes it.
#[derive(Debug, Clone, Serialize)]
pub struct OpenRecordingView {
    pub handle: RecordingHandle,
    pub is_active: bool,
    pub summary: ProfileSummary,
}

/// Filters as sent by the UI: thread indices and a start-relative time
/// range, both bounds included.
///
/// An empty selection is not a filter — an empty thread list, or a range
/// holding no instant, widens back to the whole recording instead of
/// emptying the views. That rule lives in [`Filters::accepts`]; here the
/// relative range only has to survive the shift to absolute time.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct RelativeFilters {
    pub threads: Option<Vec<u32>>,
    pub time_range_nanos: Option<(i64, i64)>,
}

pub fn open_recording_impl(
    state: &RecordingState,
    recents_store: &Path,
    path: &str,
    now_ms: u64,
) -> Result<OpenedRecording, String> {
    // Already open: reactivate rather than re-read. The file may have
    // vanished from disk since it was opened, so this must succeed
    // unconditionally, using the size recorded at open time.
    {
        let mut recordings = state.0.lock().unwrap();
        if let Some(idx) = recordings.position_of_path(path) {
            let (handle, entry) = &recordings.open[idx];
            let handle = *handle;
            let summary = summarize(&entry.profile);
            let size_bytes = entry.size_bytes;
            recordings.active = Some(handle);
            drop(recordings);
            let _ = recents::record_open(recents_store, path, size_bytes, now_ms);
            return Ok(OpenedRecording { handle, summary });
        }
    }

    let file = File::open(path).map_err(|e| format!("cannot open {path}: {e}"))?;
    let size_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let profile = jfr_ingest::read_profile(file).map_err(|e| e.to_string())?;
    let summary = summarize(&profile);

    let handle = {
        let mut recordings = state.0.lock().unwrap();
        let handle = recordings.allocate_handle();
        recordings.open.push((
            handle,
            OpenEntry {
                path: path.to_string(),
                size_bytes,
                profile,
            },
        ));
        recordings.active = Some(handle);
        handle
    };
    // Only successful opens enter the recents list, and the list is a
    // convenience: failing to persist it must not fail the open itself.
    let _ = recents::record_open(recents_store, path, size_bytes, now_ms);
    Ok(OpenedRecording { handle, summary })
}

/// Closes one open recording. Filters live client-side and die with it;
/// the recents list is untouched — closing is not forgetting.
///
/// If the closed recording was active, the new active one is whatever sat
/// immediately before it in tab order, or else whatever now sits in its old
/// slot, or else none if nothing is left open. A no-op if `handle` isn't
/// open — closing is idempotent, not an error.
pub fn close_recording_impl(state: &RecordingState, handle: RecordingHandle) {
    let mut recordings = state.0.lock().unwrap();
    let Some(idx) = recordings.position_of_handle(handle) else {
        return;
    };
    recordings.open.remove(idx);
    if recordings.active == Some(handle) {
        recordings.active = if idx > 0 {
            recordings.open.get(idx - 1)
        } else {
            recordings.open.get(idx)
        }
        .map(|(h, _)| *h);
    }
}

/// Makes an already-open recording the active one. Errors, leaving the
/// active recording untouched, if `handle` doesn't resolve to an open
/// entry.
pub fn activate_recording_impl(
    state: &RecordingState,
    handle: RecordingHandle,
) -> Result<(), String> {
    let mut recordings = state.0.lock().unwrap();
    if recordings.position_of_handle(handle).is_none() {
        return Err("no open recording with that handle".to_string());
    }
    recordings.active = Some(handle);
    Ok(())
}

/// Every open recording, in tab order, with `is_active` marking the current
/// one.
pub fn list_open_recordings_impl(state: &RecordingState) -> Vec<OpenRecordingView> {
    let recordings = state.0.lock().unwrap();
    recordings
        .open
        .iter()
        .map(|(handle, entry)| OpenRecordingView {
            handle: *handle,
            is_active: recordings.active == Some(*handle),
            summary: summarize(&entry.profile),
        })
        .collect()
}

pub fn get_top_methods_impl(
    state: &RecordingState,
    handle: RecordingHandle,
    filters: RelativeFilters,
) -> Result<TopMethods, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.profile(handle)?;
    let filters = to_absolute(profile, filters);
    Ok(jfr_aggregate::top_methods(profile, &filters))
}

pub fn get_flamegraph_impl(
    state: &RecordingState,
    handle: RecordingHandle,
    filters: RelativeFilters,
) -> Result<FlameNode, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.profile(handle)?;
    let filters = to_absolute(profile, filters);
    Ok(jfr_aggregate::flame_graph(profile, &filters))
}

pub fn get_heatmap_impl(
    state: &RecordingState,
    handle: RecordingHandle,
    filters: RelativeFilters,
) -> Result<HeatmapGrid, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.profile(handle)?;
    let filters = to_absolute(profile, filters);
    Ok(jfr_aggregate::heatmap(profile, &filters))
}

pub fn get_merged_calls_impl(
    state: &RecordingState,
    handle: RecordingHandle,
    frame_id: u32,
    filters: RelativeFilters,
) -> Result<MergedCallTree, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.profile(handle)?;
    let filters = to_absolute(profile, filters);
    Ok(jfr_aggregate::merged_calls(
        profile,
        &filters,
        FrameId(frame_id),
    ))
}

pub fn get_sample_density_impl(
    state: &RecordingState,
    handle: RecordingHandle,
    buckets: u32,
) -> Result<SampleDensity, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.profile(handle)?;
    Ok(jfr_aggregate::sample_density(profile, buckets as usize))
}

pub fn get_recording_info_impl(
    state: &RecordingState,
    handle: RecordingHandle,
) -> Result<RecordingInfo, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.profile(handle)?;
    Ok(profile.info.clone())
}

/// The overview signals, downsampled and shifted to recording-relative
/// timestamps. Points recorded before the first sample come out with a
/// slightly negative timestamp; the charts clamp them to the left edge.
#[derive(Debug, Clone, Default, Serialize)]
pub struct OverviewSignals {
    pub cpu_jvm_user: Vec<TimePoint>,
    pub cpu_jvm_system: Vec<TimePoint>,
    pub cpu_machine_total: Vec<TimePoint>,
    pub heap_used_bytes: Vec<TimePoint>,
    pub heap_committed_bytes: Vec<TimePoint>,
    pub rss_bytes: Vec<TimePoint>,
    pub gc_pauses: Vec<GcPause>,
}

pub fn get_overview_signals_impl(
    state: &RecordingState,
    handle: RecordingHandle,
    max_points: u32,
) -> Result<OverviewSignals, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.profile(handle)?;
    let start = profile.time_range_nanos().map(|(s, _)| s).unwrap_or(0);
    let series = |points: &[TimePoint]| {
        jfr_aggregate::resample_max(points, max_points as usize)
            .into_iter()
            .map(|p| TimePoint {
                ts_nanos: p.ts_nanos - start,
                value: p.value,
            })
            .collect()
    };
    Ok(OverviewSignals {
        cpu_jvm_user: series(&profile.signals.cpu_jvm_user),
        cpu_jvm_system: series(&profile.signals.cpu_jvm_system),
        cpu_machine_total: series(&profile.signals.cpu_machine_total),
        heap_used_bytes: series(&profile.signals.heap_used_bytes),
        heap_committed_bytes: series(&profile.signals.heap_committed_bytes),
        rss_bytes: series(&profile.signals.rss_bytes),
        gc_pauses: profile
            .signals
            .gc_pauses
            .iter()
            .map(|pause| GcPause {
                ts_nanos: pause.ts_nanos - start,
                ..pause.clone()
            })
            .collect(),
    })
}

fn summarize(profile: &Profile) -> ProfileSummary {
    let (start, end) = profile.time_range_nanos().unwrap_or((0, 0));
    ProfileSummary {
        sample_count: profile.samples.len() as u64,
        duration_nanos: end - start,
        threads: profile.threads.clone(),
        thread_sample_counts: jfr_aggregate::thread_sample_counts(profile),
        frames: profile.frames.clone(),
    }
}

fn to_absolute(profile: &Profile, filters: RelativeFilters) -> Filters {
    let start = profile.time_range_nanos().map(|(s, _)| s).unwrap_or(0);
    Filters {
        threads: filters
            .threads
            .map(|ids| ids.into_iter().map(ThreadId).collect()),
        // The filter upper bound is exclusive; keep the recording's last
        // sample selectable by treating the range end inclusively.
        time_range_nanos: filters
            .time_range_nanos
            .map(|(from, to)| (start + from, start + to + 1)),
    }
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn open_recording(
    state: tauri::State<'_, RecordingState>,
    recents: tauri::State<'_, RecentsState>,
    path: String,
) -> Result<OpenedRecording, String> {
    open_recording_impl(&state, &recents.0, &path, epoch_ms())
}

#[tauri::command]
pub fn close_recording(state: tauri::State<'_, RecordingState>, handle: RecordingHandle) {
    close_recording_impl(&state, handle);
}

#[tauri::command]
pub fn activate_recording(
    state: tauri::State<'_, RecordingState>,
    handle: RecordingHandle,
) -> Result<(), String> {
    activate_recording_impl(&state, handle)
}

#[tauri::command]
pub fn list_open_recordings(state: tauri::State<'_, RecordingState>) -> Vec<OpenRecordingView> {
    list_open_recordings_impl(&state)
}

#[tauri::command]
pub fn get_top_methods(
    state: tauri::State<'_, RecordingState>,
    handle: RecordingHandle,
    filters: RelativeFilters,
) -> Result<TopMethods, String> {
    get_top_methods_impl(&state, handle, filters)
}

#[tauri::command]
pub fn get_flamegraph(
    state: tauri::State<'_, RecordingState>,
    handle: RecordingHandle,
    filters: RelativeFilters,
) -> Result<FlameNode, String> {
    get_flamegraph_impl(&state, handle, filters)
}

#[tauri::command]
pub fn get_heatmap(
    state: tauri::State<'_, RecordingState>,
    handle: RecordingHandle,
    filters: RelativeFilters,
) -> Result<HeatmapGrid, String> {
    get_heatmap_impl(&state, handle, filters)
}

#[tauri::command]
pub fn get_merged_calls(
    state: tauri::State<'_, RecordingState>,
    handle: RecordingHandle,
    frame_id: u32,
    filters: RelativeFilters,
) -> Result<MergedCallTree, String> {
    get_merged_calls_impl(&state, handle, frame_id, filters)
}

#[tauri::command]
pub fn get_sample_density(
    state: tauri::State<'_, RecordingState>,
    handle: RecordingHandle,
    buckets: u32,
) -> Result<SampleDensity, String> {
    get_sample_density_impl(&state, handle, buckets)
}

#[tauri::command]
pub fn get_recording_info(
    state: tauri::State<'_, RecordingState>,
    handle: RecordingHandle,
) -> Result<RecordingInfo, String> {
    get_recording_info_impl(&state, handle)
}

#[tauri::command]
pub fn get_overview_signals(
    state: tauri::State<'_, RecordingState>,
    handle: RecordingHandle,
    max_points: u32,
) -> Result<OverviewSignals, String> {
    get_overview_signals_impl(&state, handle, max_points)
}

/// A recents entry as the welcome screen consumes it: the persisted entry
/// plus whether the file is still there — checked at list time, so a file
/// deleted since its last open shows as missing instead of failing later.
#[derive(Debug, Clone, Serialize)]
pub struct RecentRecordingView {
    #[serde(flatten)]
    pub entry: RecentRecording,
    pub exists: bool,
}

fn with_existence(list: Vec<RecentRecording>) -> Vec<RecentRecordingView> {
    list.into_iter()
        .map(|entry| RecentRecordingView {
            exists: Path::new(&entry.path).exists(),
            entry,
        })
        .collect()
}

#[tauri::command]
pub fn list_recent_recordings(recents: tauri::State<'_, RecentsState>) -> Vec<RecentRecordingView> {
    with_existence(recents::load(&recents.0))
}

#[tauri::command]
pub fn remove_recent_recording(
    recents: tauri::State<'_, RecentsState>,
    path: String,
) -> Result<Vec<RecentRecordingView>, String> {
    recents::remove(&recents.0, &path).map(with_existence)
}

#[tauri::command]
pub fn clear_recent_recordings(
    recents: tauri::State<'_, RecentsState>,
) -> Result<Vec<RecentRecordingView>, String> {
    recents::clear(&recents.0).map(with_existence)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/fixture.jfr");
    const METADATA_FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/fixture-metadata.jfr"
    );

    fn temp_store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("recents.json");
        (dir, store)
    }

    fn loaded_state() -> (RecordingState, RecordingHandle, ProfileSummary) {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let opened = open_recording_impl(&state, &store, FIXTURE, 0).unwrap();
        (state, opened.handle, opened.summary)
    }

    #[test]
    fn open_recording_returns_the_summary() {
        let (_, _, summary) = loaded_state();
        assert_eq!(summary.sample_count, 570);
        assert!(summary.duration_nanos > 1_000_000_000);
        assert!(summary.threads.iter().any(|t| t.name == "fixture-worker"));
        assert!(!summary.frames.is_empty());
        assert_eq!(summary.thread_sample_counts.len(), summary.threads.len());
        assert_eq!(
            summary.thread_sample_counts.iter().sum::<u64>(),
            summary.sample_count
        );
    }

    #[test]
    fn recording_info_and_signals_require_a_loaded_recording() {
        let state = RecordingState::default();
        let handle = RecordingHandle(0);
        assert!(get_recording_info_impl(&state, handle).is_err());
        assert!(get_overview_signals_impl(&state, handle, 100).is_err());
    }

    #[test]
    fn recording_info_reflects_the_recorded_jvm() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let opened = open_recording_impl(&state, &store, METADATA_FIXTURE, 0).unwrap();
        let info = get_recording_info_impl(&state, opened.handle).unwrap();
        assert_eq!(info.jvm_name.as_deref(), Some("OpenJDK 64-Bit Server VM"));
        assert_eq!(info.xmx.unwrap().value, 256 * 1024 * 1024);
        assert!(info.debug_non_safepoints.unwrap().value);
    }

    #[test]
    fn recording_info_is_empty_for_a_minimal_recording() {
        let (state, handle, _) = loaded_state();
        let info = get_recording_info_impl(&state, handle).unwrap();
        assert_eq!(info, jfr_model::RecordingInfo::default());
    }

    #[test]
    fn overview_signals_are_relative_and_bounded() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let opened = open_recording_impl(&state, &store, METADATA_FIXTURE, 0).unwrap();
        let signals = get_overview_signals_impl(&state, opened.handle, 50).unwrap();

        assert!(!signals.cpu_jvm_user.is_empty());
        assert!(signals.cpu_jvm_user.len() <= 50);
        assert!(!signals.heap_used_bytes.is_empty());
        assert!(!signals.rss_bytes.is_empty());
        assert!(!signals.gc_pauses.is_empty());

        // Relative clock: everything sits in (or marginally before) the
        // recording span, never in absolute epoch territory.
        let margin = 2_000_000_000;
        for p in signals.cpu_jvm_user.iter().chain(&signals.rss_bytes) {
            assert!(p.ts_nanos > -margin && p.ts_nanos < opened.summary.duration_nanos + margin);
        }
        for p in &signals.gc_pauses {
            assert!(p.ts_nanos > -margin && p.ts_nanos < opened.summary.duration_nanos + margin);
        }
    }

    #[test]
    fn sample_density_covers_every_sample() {
        let (state, handle, summary) = loaded_state();
        let density = get_sample_density_impl(&state, handle, 100).unwrap();
        assert!(density.counts.len() <= 100);
        assert_eq!(density.counts.iter().sum::<u64>(), summary.sample_count);
    }

    #[test]
    fn sample_density_requires_a_loaded_recording() {
        let state = RecordingState::default();
        let err = get_sample_density_impl(&state, RecordingHandle(0), 100).unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn open_recording_reports_missing_file() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let err = open_recording_impl(&state, &store, "/nonexistent.jfr", 0).unwrap_err();
        assert!(err.contains("/nonexistent.jfr"));
    }

    #[test]
    fn a_successful_open_enters_the_recents_list() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        open_recording_impl(&state, &store, FIXTURE, 1234).unwrap();
        let list = recents::load(&store);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, FIXTURE);
        assert_eq!(list[0].last_opened_ms, 1234);
        assert!(list[0].size_bytes > 0);
    }

    #[test]
    fn a_failed_open_leaves_the_recents_list_alone() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        open_recording_impl(&state, &store, FIXTURE, 1).unwrap();
        let before = recents::load(&store);
        open_recording_impl(&state, &store, "/nonexistent.jfr", 2).unwrap_err();
        assert_eq!(recents::load(&store), before);
    }

    #[test]
    fn a_failed_open_keeps_the_loaded_recording() {
        let (state, handle, summary) = loaded_state();
        let (_dir, store) = temp_store();
        open_recording_impl(&state, &store, "/nonexistent.jfr", 0).unwrap_err();
        let view = get_top_methods_impl(&state, handle, RelativeFilters::default()).unwrap();
        assert_eq!(view.total_samples, summary.sample_count);
    }

    #[test]
    fn recents_report_whether_the_file_still_exists() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        open_recording_impl(&state, &store, FIXTURE, 1).unwrap();
        recents::record_open(&store, "/vanished.jfr", 0, 2).unwrap();

        let views = with_existence(recents::load(&store));
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].entry.path, "/vanished.jfr");
        assert!(!views[0].exists);
        assert_eq!(views[1].entry.path, FIXTURE);
        assert!(views[1].exists);
    }

    #[test]
    fn close_recording_drops_the_profile() {
        let (state, handle, _) = loaded_state();
        close_recording_impl(&state, handle);
        let err = get_top_methods_impl(&state, handle, RelativeFilters::default()).unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn top_methods_requires_a_loaded_recording() {
        let state = RecordingState::default();
        let err = get_top_methods_impl(&state, RecordingHandle(0), RelativeFilters::default())
            .unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn top_methods_covers_all_samples_without_filters() {
        let (state, handle, summary) = loaded_state();
        let view = get_top_methods_impl(&state, handle, RelativeFilters::default()).unwrap();
        assert_eq!(view.total_samples, summary.sample_count);
    }

    #[test]
    fn full_relative_time_range_keeps_every_sample() {
        let (state, handle, summary) = loaded_state();
        let view = get_top_methods_impl(
            &state,
            handle,
            RelativeFilters {
                time_range_nanos: Some((0, summary.duration_nanos)),
                ..RelativeFilters::default()
            },
        )
        .unwrap();
        assert_eq!(view.total_samples, summary.sample_count);
    }

    #[test]
    fn an_empty_selection_keeps_every_sample() {
        let (state, handle, summary) = loaded_state();
        for filters in [
            RelativeFilters {
                threads: Some(vec![]),
                ..RelativeFilters::default()
            },
            // A brush that selected no instant: end before start.
            RelativeFilters {
                time_range_nanos: Some((summary.duration_nanos, 0)),
                ..RelativeFilters::default()
            },
        ] {
            let view = get_top_methods_impl(&state, handle, filters.clone()).unwrap();
            assert_eq!(view.total_samples, summary.sample_count, "{filters:?}");
        }
    }

    #[test]
    fn thread_filter_narrows_the_view() {
        let (state, handle, summary) = loaded_state();
        let worker = summary
            .threads
            .iter()
            .find(|t| t.name == "fixture-worker")
            .unwrap();
        let view = get_top_methods_impl(
            &state,
            handle,
            RelativeFilters {
                threads: Some(vec![worker.id.0]),
                ..RelativeFilters::default()
            },
        )
        .unwrap();
        assert!(view.total_samples > 0);
        assert!(view.total_samples < summary.sample_count);
    }

    #[test]
    fn flamegraph_requires_a_loaded_recording() {
        let state = RecordingState::default();
        let err = get_flamegraph_impl(&state, RecordingHandle(0), RelativeFilters::default())
            .unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn flamegraph_root_covers_all_samples_without_filters() {
        let (state, handle, summary) = loaded_state();
        let root = get_flamegraph_impl(&state, handle, RelativeFilters::default()).unwrap();
        assert_eq!(root.frame, None);
        assert_eq!(root.samples, summary.sample_count);
    }

    #[test]
    fn flamegraph_thread_filter_narrows_the_tree() {
        let (state, handle, summary) = loaded_state();
        let worker = summary
            .threads
            .iter()
            .find(|t| t.name == "fixture-worker")
            .unwrap();
        let root = get_flamegraph_impl(
            &state,
            handle,
            RelativeFilters {
                threads: Some(vec![worker.id.0]),
                ..RelativeFilters::default()
            },
        )
        .unwrap();
        assert!(root.samples > 0);
        assert!(root.samples < summary.sample_count);
    }

    #[test]
    fn heatmap_requires_a_loaded_recording() {
        let state = RecordingState::default();
        let err =
            get_heatmap_impl(&state, RecordingHandle(0), RelativeFilters::default()).unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn heatmap_grid_covers_all_samples_without_filters() {
        let (state, handle, summary) = loaded_state();
        let grid = get_heatmap_impl(&state, handle, RelativeFilters::default()).unwrap();
        let total: u64 = grid.columns.iter().flatten().sum();
        assert_eq!(total, summary.sample_count);
    }

    #[test]
    fn heatmap_thread_filter_narrows_the_grid() {
        let (state, handle, summary) = loaded_state();
        let worker = summary
            .threads
            .iter()
            .find(|t| t.name == "fixture-worker")
            .unwrap();
        let grid = get_heatmap_impl(
            &state,
            handle,
            RelativeFilters {
                threads: Some(vec![worker.id.0]),
                ..RelativeFilters::default()
            },
        )
        .unwrap();
        let total: u64 = grid.columns.iter().flatten().sum();
        assert!(total > 0);
        assert!(total < summary.sample_count);
    }

    fn frame_id(summary: &ProfileSummary, label: &str) -> u32 {
        summary
            .frames
            .iter()
            .position(|f| f.label() == label)
            .unwrap_or_else(|| panic!("no frame for {label}")) as u32
    }

    #[test]
    fn merged_calls_requires_a_loaded_recording() {
        let state = RecordingState::default();
        let err = get_merged_calls_impl(&state, RecordingHandle(0), 0, RelativeFilters::default())
            .unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn merged_calls_trees_are_rooted_at_the_focus_without_filters() {
        let (state, handle, summary) = loaded_state();
        let focus = frame_id(&summary, "FixtureWorkload.hotCoordinator");
        let tree =
            get_merged_calls_impl(&state, handle, focus, RelativeFilters::default()).unwrap();

        assert_eq!(tree.focus.0, focus);
        assert_eq!(tree.callers.frame, Some(tree.focus));
        assert_eq!(tree.callees.frame, Some(tree.focus));
        assert_eq!(tree.callers.samples, tree.callees.samples);
        assert!(tree.callers.samples > 0);
        assert!(tree.callers.samples <= summary.sample_count);
    }

    #[test]
    fn merged_calls_thread_filter_narrows_the_trees() {
        let (state, handle, summary) = loaded_state();
        let focus = frame_id(&summary, "FixtureWorkload.hotCoordinator");
        let unfiltered =
            get_merged_calls_impl(&state, handle, focus, RelativeFilters::default()).unwrap();
        let worker = summary
            .threads
            .iter()
            .find(|t| t.name == "fixture-worker")
            .unwrap();
        let narrowed = get_merged_calls_impl(
            &state,
            handle,
            focus,
            RelativeFilters {
                threads: Some(vec![worker.id.0]),
                ..RelativeFilters::default()
            },
        )
        .unwrap();

        assert!(narrowed.callers.samples > 0);
        assert!(narrowed.callers.samples < unfiltered.callers.samples);
    }

    #[test]
    fn merged_calls_for_a_frame_absent_from_the_selection_has_no_samples() {
        let (state, handle, summary) = loaded_state();
        let absent = summary.frames.len() as u32;
        let tree =
            get_merged_calls_impl(&state, handle, absent, RelativeFilters::default()).unwrap();

        assert_eq!(tree.callers.samples, 0);
        assert_eq!(tree.callees.samples, 0);
    }

    #[test]
    fn opening_two_recordings_yields_two_independent_handles() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let first = open_recording_impl(&state, &store, FIXTURE, 0).unwrap();
        let second = open_recording_impl(&state, &store, METADATA_FIXTURE, 1).unwrap();
        assert_ne!(first.handle, second.handle);

        let first_info = get_recording_info_impl(&state, first.handle).unwrap();
        assert_eq!(first_info, jfr_model::RecordingInfo::default());
        let second_info = get_recording_info_impl(&state, second.handle).unwrap();
        assert_eq!(
            second_info.jvm_name.as_deref(),
            Some("OpenJDK 64-Bit Server VM")
        );

        let open = list_open_recordings_impl(&state);
        assert_eq!(open.len(), 2);
        assert_eq!(open[0].handle, first.handle);
        assert!(!open[0].is_active);
        assert_eq!(open[1].handle, second.handle);
        assert!(open[1].is_active);
    }

    #[test]
    fn reopening_an_open_path_returns_the_same_handle() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let first = open_recording_impl(&state, &store, FIXTURE, 0).unwrap();
        open_recording_impl(&state, &store, METADATA_FIXTURE, 1).unwrap();
        let reopened = open_recording_impl(&state, &store, FIXTURE, 2).unwrap();

        assert_eq!(reopened.handle, first.handle);
        let open = list_open_recordings_impl(&state);
        assert_eq!(open.len(), 2, "no duplicate entry for the reopened path");
        assert!(
            open.iter()
                .find(|v| v.handle == first.handle)
                .unwrap()
                .is_active
        );
    }

    #[test]
    fn closing_the_active_recording_activates_the_previous_one() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let first = open_recording_impl(&state, &store, FIXTURE, 0).unwrap();
        let second = open_recording_impl(&state, &store, METADATA_FIXTURE, 1).unwrap();

        close_recording_impl(&state, second.handle);

        let open = list_open_recordings_impl(&state);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].handle, first.handle);
        assert!(open[0].is_active);
    }

    #[test]
    fn closing_the_only_open_recording_leaves_nothing_active() {
        let (state, handle, _) = loaded_state();
        close_recording_impl(&state, handle);

        assert!(list_open_recordings_impl(&state).is_empty());
        let err = get_top_methods_impl(&state, handle, RelativeFilters::default()).unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn closing_a_non_active_recording_leaves_the_active_one_untouched() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let first = open_recording_impl(&state, &store, FIXTURE, 0).unwrap();
        let second = open_recording_impl(&state, &store, METADATA_FIXTURE, 1).unwrap();

        close_recording_impl(&state, first.handle);

        let open = list_open_recordings_impl(&state);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].handle, second.handle);
        assert!(open[0].is_active);
    }

    #[test]
    fn activate_recording_switches_the_active_handle() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let first = open_recording_impl(&state, &store, FIXTURE, 0).unwrap();
        let second = open_recording_impl(&state, &store, METADATA_FIXTURE, 1).unwrap();
        assert!(list_open_recordings_impl(&state)[1].is_active);

        activate_recording_impl(&state, first.handle).unwrap();

        let open = list_open_recordings_impl(&state);
        assert!(
            open.iter()
                .find(|v| v.handle == first.handle)
                .unwrap()
                .is_active
        );
        assert!(
            !open
                .iter()
                .find(|v| v.handle == second.handle)
                .unwrap()
                .is_active
        );
    }

    #[test]
    fn activate_recording_rejects_an_unknown_handle() {
        let (state, handle, _) = loaded_state();
        let err = activate_recording_impl(&state, RecordingHandle(handle.0 + 1)).unwrap_err();
        assert!(err.contains("no open recording"));
    }
}
