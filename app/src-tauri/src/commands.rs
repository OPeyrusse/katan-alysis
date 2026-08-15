//! IPC commands. Each `#[tauri::command]` is a thin wrapper over a plain
//! function taking `&RecordingState`, so the logic is unit-testable without
//! a webview.
//!
//! Timestamps cross the IPC boundary as nanoseconds *relative to the start
//! of the recording*: absolute epoch nanoseconds exceed JavaScript's safe
//! integer range, relative ones don't.

use std::fs::File;
use std::sync::Mutex;

use jfr_model::{Filters, Frame, Profile, ThreadId, ThreadInfo, TopMethods};
use serde::{Deserialize, Serialize};

/// The recording currently loaded in the application.
#[derive(Default)]
pub struct RecordingState(Mutex<Option<Profile>>);

/// What the UI needs up front: dictionaries and global bounds. Views then
/// reference frames and threads by index.
#[derive(Debug, Clone, Serialize)]
pub struct ProfileSummary {
    pub sample_count: u64,
    /// Recording span in nanoseconds; UI timestamps live in `[0, duration]`.
    pub duration_nanos: i64,
    pub threads: Vec<ThreadInfo>,
    pub frames: Vec<Frame>,
}

/// Filters as sent by the UI: thread indices and a start-relative time range.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct RelativeFilters {
    pub threads: Option<Vec<u32>>,
    pub time_range_nanos: Option<(i64, i64)>,
}

pub fn open_recording_impl(state: &RecordingState, path: &str) -> Result<ProfileSummary, String> {
    let file = File::open(path).map_err(|e| format!("cannot open {path}: {e}"))?;
    let profile = jfr_ingest::read_profile(file).map_err(|e| e.to_string())?;
    let summary = summarize(&profile);
    *state.0.lock().unwrap() = Some(profile);
    Ok(summary)
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

fn summarize(profile: &Profile) -> ProfileSummary {
    let (start, end) = profile.time_range_nanos().unwrap_or((0, 0));
    ProfileSummary {
        sample_count: profile.samples.len() as u64,
        duration_nanos: end - start,
        threads: profile.threads.clone(),
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

#[tauri::command]
pub fn open_recording(
    state: tauri::State<'_, RecordingState>,
    path: String,
) -> Result<ProfileSummary, String> {
    open_recording_impl(&state, &path)
}

#[tauri::command]
pub fn get_top_methods(
    state: tauri::State<'_, RecordingState>,
    filters: RelativeFilters,
) -> Result<TopMethods, String> {
    get_top_methods_impl(&state, filters)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/fixture.jfr");

    fn loaded_state() -> (RecordingState, ProfileSummary) {
        let state = RecordingState::default();
        let summary = open_recording_impl(&state, FIXTURE).unwrap();
        (state, summary)
    }

    #[test]
    fn open_recording_returns_the_summary() {
        let (_, summary) = loaded_state();
        assert_eq!(summary.sample_count, 570);
        assert!(summary.duration_nanos > 1_000_000_000);
        assert!(summary.threads.iter().any(|t| t.name == "fixture-worker"));
        assert!(!summary.frames.is_empty());
    }

    #[test]
    fn open_recording_reports_missing_file() {
        let state = RecordingState::default();
        let err = open_recording_impl(&state, "/nonexistent.jfr").unwrap_err();
        assert!(err.contains("/nonexistent.jfr"));
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
