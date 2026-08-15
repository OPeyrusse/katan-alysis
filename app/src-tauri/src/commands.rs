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

use jfr_model::{Filters, Frame, Profile, SampleDensity, ThreadId, ThreadInfo, TopMethods};
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

pub fn get_sample_density_impl(
    state: &RecordingState,
    buckets: u32,
) -> Result<SampleDensity, String> {
    let guard = state.0.lock().unwrap();
    let profile = guard.as_ref().ok_or("no recording loaded")?;
    Ok(jfr_aggregate::sample_density(profile, buckets as usize))
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
pub fn get_sample_density(
    state: tauri::State<'_, RecordingState>,
    buckets: u32,
) -> Result<SampleDensity, String> {
    get_sample_density_impl(&state, buckets)
}

#[tauri::command]
pub fn list_recent_recordings(recents: tauri::State<'_, RecentsState>) -> Vec<RecentRecording> {
    recents::load(&recents.0)
}

#[tauri::command]
pub fn remove_recent_recording(
    recents: tauri::State<'_, RecentsState>,
    path: String,
) -> Result<Vec<RecentRecording>, String> {
    recents::remove(&recents.0, &path)
}

#[tauri::command]
pub fn clear_recent_recordings(
    recents: tauri::State<'_, RecentsState>,
) -> Result<Vec<RecentRecording>, String> {
    recents::clear(&recents.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/fixture.jfr");

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
}
