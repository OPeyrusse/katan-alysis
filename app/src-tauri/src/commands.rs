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
    Filters, FlameNode, Frame, GcPause, HeatmapGrid, Profile, RecordingInfo, SampleDensity,
    ThreadId, ThreadInfo, TimePoint, TopMethods,
};
use serde::{Deserialize, Serialize};

use crate::recents::{self, RecentRecording};

/// The recording currently loaded in the application.
#[derive(Default)]
pub struct RecordingState(Mutex<Option<Profile>>);

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
) -> Result<ProfileSummary, String> {
    let file = File::open(path).map_err(|e| format!("cannot open {path}: {e}"))?;
    let size_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let profile = jfr_ingest::read_profile(file).map_err(|e| e.to_string())?;
    let summary = summarize(&profile);
    *state.0.lock().unwrap() = Some(profile);
    // Only successful opens enter the recents list, and the list is a
    // convenience: failing to persist it must not fail the open itself.
    let _ = recents::record_open(recents_store, path, size_bytes, now_ms);
    Ok(summary)
}

/// Drops the loaded recording. Filters live client-side and die with it;
/// the recents list is untouched — closing is not forgetting.
pub fn close_recording_impl(state: &RecordingState) {
    *state.0.lock().unwrap() = None;
}

pub fn get_top_methods_impl(
    state: &RecordingState,
    filters: RelativeFilters,
) -> Result<TopMethods, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.as_ref().ok_or("no recording loaded")?;
    let filters = to_absolute(profile, filters);
    Ok(jfr_aggregate::top_methods(profile, &filters))
}

pub fn get_flamegraph_impl(
    state: &RecordingState,
    filters: RelativeFilters,
) -> Result<FlameNode, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.as_ref().ok_or("no recording loaded")?;
    let filters = to_absolute(profile, filters);
    Ok(jfr_aggregate::flame_graph(profile, &filters))
}

pub fn get_heatmap_impl(
    state: &RecordingState,
    filters: RelativeFilters,
) -> Result<HeatmapGrid, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.as_ref().ok_or("no recording loaded")?;
    let filters = to_absolute(profile, filters);
    Ok(jfr_aggregate::heatmap(profile, &filters))
}

pub fn get_sample_density_impl(
    state: &RecordingState,
    buckets: u32,
) -> Result<SampleDensity, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.as_ref().ok_or("no recording loaded")?;
    Ok(jfr_aggregate::sample_density(profile, buckets as usize))
}

pub fn get_recording_info_impl(state: &RecordingState) -> Result<RecordingInfo, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.as_ref().ok_or("no recording loaded")?;
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
    max_points: u32,
) -> Result<OverviewSignals, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.as_ref().ok_or("no recording loaded")?;
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
) -> Result<ProfileSummary, String> {
    open_recording_impl(&state, &recents.0, &path, epoch_ms())
}

#[tauri::command]
pub fn close_recording(state: tauri::State<'_, RecordingState>) {
    close_recording_impl(&state);
}

#[tauri::command]
pub fn get_top_methods(
    state: tauri::State<'_, RecordingState>,
    filters: RelativeFilters,
) -> Result<TopMethods, String> {
    get_top_methods_impl(&state, filters)
}

#[tauri::command]
pub fn get_flamegraph(
    state: tauri::State<'_, RecordingState>,
    filters: RelativeFilters,
) -> Result<FlameNode, String> {
    get_flamegraph_impl(&state, filters)
}

#[tauri::command]
pub fn get_heatmap(
    state: tauri::State<'_, RecordingState>,
    filters: RelativeFilters,
) -> Result<HeatmapGrid, String> {
    get_heatmap_impl(&state, filters)
}

#[tauri::command]
pub fn get_sample_density(
    state: tauri::State<'_, RecordingState>,
    buckets: u32,
) -> Result<SampleDensity, String> {
    get_sample_density_impl(&state, buckets)
}

#[tauri::command]
pub fn get_recording_info(
    state: tauri::State<'_, RecordingState>,
) -> Result<RecordingInfo, String> {
    get_recording_info_impl(&state)
}

#[tauri::command]
pub fn get_overview_signals(
    state: tauri::State<'_, RecordingState>,
    max_points: u32,
) -> Result<OverviewSignals, String> {
    get_overview_signals_impl(&state, max_points)
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

    fn loaded_state() -> (RecordingState, ProfileSummary) {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let summary = open_recording_impl(&state, &store, FIXTURE, 0).unwrap();
        (state, summary)
    }

    #[test]
    fn open_recording_returns_the_summary() {
        let (_, summary) = loaded_state();
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
        assert!(get_recording_info_impl(&state).is_err());
        assert!(get_overview_signals_impl(&state, 100).is_err());
    }

    #[test]
    fn recording_info_reflects_the_recorded_jvm() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        open_recording_impl(&state, &store, METADATA_FIXTURE, 0).unwrap();
        let info = get_recording_info_impl(&state).unwrap();
        assert_eq!(info.jvm_name.as_deref(), Some("OpenJDK 64-Bit Server VM"));
        assert_eq!(info.xmx.unwrap().value, 256 * 1024 * 1024);
        assert!(info.debug_non_safepoints.unwrap().value);
    }

    #[test]
    fn recording_info_is_empty_for_a_minimal_recording() {
        let (state, _) = loaded_state();
        let info = get_recording_info_impl(&state).unwrap();
        assert_eq!(info, jfr_model::RecordingInfo::default());
    }

    #[test]
    fn overview_signals_are_relative_and_bounded() {
        let (_dir, store) = temp_store();
        let state = RecordingState::default();
        let summary = open_recording_impl(&state, &store, METADATA_FIXTURE, 0).unwrap();
        let signals = get_overview_signals_impl(&state, 50).unwrap();

        assert!(!signals.cpu_jvm_user.is_empty());
        assert!(signals.cpu_jvm_user.len() <= 50);
        assert!(!signals.heap_used_bytes.is_empty());
        assert!(!signals.rss_bytes.is_empty());
        assert!(!signals.gc_pauses.is_empty());

        // Relative clock: everything sits in (or marginally before) the
        // recording span, never in absolute epoch territory.
        let margin = 2_000_000_000;
        for p in signals.cpu_jvm_user.iter().chain(&signals.rss_bytes) {
            assert!(p.ts_nanos > -margin && p.ts_nanos < summary.duration_nanos + margin);
        }
        for p in &signals.gc_pauses {
            assert!(p.ts_nanos > -margin && p.ts_nanos < summary.duration_nanos + margin);
        }
    }

    #[test]
    fn sample_density_covers_every_sample() {
        let (state, summary) = loaded_state();
        let density = get_sample_density_impl(&state, 100).unwrap();
        assert!(density.counts.len() <= 100);
        assert_eq!(density.counts.iter().sum::<u64>(), summary.sample_count);
    }

    #[test]
    fn sample_density_requires_a_loaded_recording() {
        let state = RecordingState::default();
        let err = get_sample_density_impl(&state, 100).unwrap_err();
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
        let (state, summary) = loaded_state();
        let (_dir, store) = temp_store();
        open_recording_impl(&state, &store, "/nonexistent.jfr", 0).unwrap_err();
        let view = get_top_methods_impl(&state, RelativeFilters::default()).unwrap();
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
        let (state, _) = loaded_state();
        close_recording_impl(&state);
        let err = get_top_methods_impl(&state, RelativeFilters::default()).unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn top_methods_requires_a_loaded_recording() {
        let state = RecordingState::default();
        let err = get_top_methods_impl(&state, RelativeFilters::default()).unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn top_methods_covers_all_samples_without_filters() {
        let (state, summary) = loaded_state();
        let view = get_top_methods_impl(&state, RelativeFilters::default()).unwrap();
        assert_eq!(view.total_samples, summary.sample_count);
    }

    #[test]
    fn full_relative_time_range_keeps_every_sample() {
        let (state, summary) = loaded_state();
        let view = get_top_methods_impl(
            &state,
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
        let (state, summary) = loaded_state();
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
            let view = get_top_methods_impl(&state, filters.clone()).unwrap();
            assert_eq!(view.total_samples, summary.sample_count, "{filters:?}");
        }
    }

    #[test]
    fn thread_filter_narrows_the_view() {
        let (state, summary) = loaded_state();
        let worker = summary
            .threads
            .iter()
            .find(|t| t.name == "fixture-worker")
            .unwrap();
        let view = get_top_methods_impl(
            &state,
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
        let err = get_flamegraph_impl(&state, RelativeFilters::default()).unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn flamegraph_root_covers_all_samples_without_filters() {
        let (state, summary) = loaded_state();
        let root = get_flamegraph_impl(&state, RelativeFilters::default()).unwrap();
        assert_eq!(root.frame, None);
        assert_eq!(root.samples, summary.sample_count);
    }

    #[test]
    fn flamegraph_thread_filter_narrows_the_tree() {
        let (state, summary) = loaded_state();
        let worker = summary
            .threads
            .iter()
            .find(|t| t.name == "fixture-worker")
            .unwrap();
        let root = get_flamegraph_impl(
            &state,
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
        let err = get_heatmap_impl(&state, RelativeFilters::default()).unwrap_err();
        assert!(err.contains("no recording loaded"));
    }

    #[test]
    fn heatmap_grid_covers_all_samples_without_filters() {
        let (state, summary) = loaded_state();
        let grid = get_heatmap_impl(&state, RelativeFilters::default()).unwrap();
        let total: u64 = grid.columns.iter().flatten().sum();
        assert_eq!(total, summary.sample_count);
    }

    #[test]
    fn heatmap_thread_filter_narrows_the_grid() {
        let (state, summary) = loaded_state();
        let worker = summary
            .threads
            .iter()
            .find(|t| t.name == "fixture-worker")
            .unwrap();
        let grid = get_heatmap_impl(
            &state,
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
}
