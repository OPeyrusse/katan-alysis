//! Tauri shell: thin IPC layer over the Rust data crates.
//!
//! Commands stay logic-free so they can be unit-tested as plain functions;
//! all aggregation lives in `jfr-aggregate`.

mod commands;
mod recents;

use tauri::Manager;

/// Liveness check used by the UI scaffold to validate the IPC wiring.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// `verbose` is the `--verbose`/`-v` CLI flag: it turns the per-entry
/// ingestion detail (which constant-pool reference or thread failed to
/// resolve) on top of the one-line-per-recording warning that always logs.
/// Both go to the OS log directory as well as stdout, so a packaged build
/// launched with the flag has somewhere to look without attaching a
/// debugger — `jfr-ingest` itself only ever reports through the `log`
/// crate, never by printing directly.
pub fn run(verbose: bool) {
    let level = if verbose {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Warn
    };
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(level)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::RecordingState::default())
        .setup(|app| {
            let store = app.path().app_config_dir()?.join("recents.json");
            app.manage(commands::RecentsState(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            commands::open_recording,
            commands::close_recording,
            commands::list_open_recordings,
            commands::activate_recording,
            commands::get_top_methods,
            commands::get_flamegraph,
            commands::get_heatmap,
            commands::get_merged_calls,
            commands::get_sample_density,
            commands::get_recording_info,
            commands::get_overview_signals,
            commands::list_recent_recordings,
            commands::remove_recent_recording,
            commands::clear_recent_recordings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn ping_answers_pong() {
        assert_eq!(super::ping(), "pong");
    }
}
