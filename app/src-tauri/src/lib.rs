//! Tauri shell: thin IPC layer over the Rust data crates.
//!
//! Commands stay logic-free so they can be unit-tested as plain functions;
//! all aggregation lives in `jfr-aggregate`.

/// Liveness check used by the UI scaffold to validate the IPC wiring.
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
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
