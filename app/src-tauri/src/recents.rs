//! Persisted list of recently opened recordings.
//!
//! A small JSON file in the app config directory, most recent first,
//! deduplicated by path and bounded. Only successful opens enter the list:
//! a failed open never rewrites history. Pure functions over a store path,
//! so everything is testable against a temp directory.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The welcome screen shows at most this many entries.
pub const MAX_RECENTS: usize = 10;

/// One entry of the recents list, as shown on the welcome screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentRecording {
    pub path: String,
    pub size_bytes: u64,
    /// Milliseconds since the epoch of the last successful open.
    pub last_opened_ms: u64,
}

/// Reads the list, most recent first. A missing or unreadable store is an
/// empty list, never an error: recents are a convenience, not data the
/// analyst can lose.
pub fn load(store: &Path) -> Vec<RecentRecording> {
    fs::read(store)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Puts `path` at the front of the list (replacing any previous entry for
/// the same path), drops entries beyond [`MAX_RECENTS`], and persists.
pub fn record_open(
    store: &Path,
    path: &str,
    size_bytes: u64,
    now_ms: u64,
) -> Result<Vec<RecentRecording>, String> {
    let mut list = load(store);
    list.retain(|entry| entry.path != path);
    list.insert(
        0,
        RecentRecording {
            path: path.to_string(),
            size_bytes,
            last_opened_ms: now_ms,
        },
    );
    list.truncate(MAX_RECENTS);
    save(store, &list)?;
    Ok(list)
}

/// Removes the entry for `path`, if any, and persists.
pub fn remove(store: &Path, path: &str) -> Result<Vec<RecentRecording>, String> {
    let mut list = load(store);
    list.retain(|entry| entry.path != path);
    save(store, &list)?;
    Ok(list)
}

/// Empties the list and persists.
pub fn clear(store: &Path) -> Result<Vec<RecentRecording>, String> {
    save(store, &[])?;
    Ok(Vec::new())
}

fn save(store: &Path, list: &[RecentRecording]) -> Result<(), String> {
    if let Some(parent) = store.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_vec_pretty(list).expect("recents always serialize");
    fs::write(store, json).map_err(|e| format!("cannot write {}: {e}", store.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join("config").join("recents.json")
    }

    #[test]
    fn a_missing_store_is_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&store(&dir)), vec![]);
    }

    #[test]
    fn a_corrupt_store_is_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let path = store(&dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not json").unwrap();
        assert_eq!(load(&path), vec![]);
    }

    #[test]
    fn record_open_puts_the_recording_first_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = store(&dir);
        record_open(&path, "/a.jfr", 10, 1000).unwrap();
        let list = record_open(&path, "/b.jfr", 20, 2000).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, "/b.jfr");
        assert_eq!(list[1].path, "/a.jfr");
        assert_eq!(load(&path), list);
    }

    #[test]
    fn reopening_a_recording_moves_it_to_the_front_without_duplicating() {
        let dir = tempfile::tempdir().unwrap();
        let path = store(&dir);
        record_open(&path, "/a.jfr", 10, 1000).unwrap();
        record_open(&path, "/b.jfr", 20, 2000).unwrap();
        let list = record_open(&path, "/a.jfr", 11, 3000).unwrap();
        assert_eq!(
            list.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            ["/a.jfr", "/b.jfr"]
        );
        assert_eq!(list[0].size_bytes, 11);
        assert_eq!(list[0].last_opened_ms, 3000);
    }

    #[test]
    fn the_list_is_bounded_to_the_most_recent_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = store(&dir);
        for i in 0..(MAX_RECENTS + 3) {
            record_open(&path, &format!("/{i}.jfr"), 0, i as u64).unwrap();
        }
        let list = load(&path);
        assert_eq!(list.len(), MAX_RECENTS);
        assert_eq!(list[0].path, format!("/{}.jfr", MAX_RECENTS + 2));
        assert_eq!(list[MAX_RECENTS - 1].path, "/3.jfr");
    }

    #[test]
    fn remove_forgets_one_entry_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = store(&dir);
        record_open(&path, "/a.jfr", 10, 1000).unwrap();
        record_open(&path, "/b.jfr", 20, 2000).unwrap();
        let list = remove(&path, "/b.jfr").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, "/a.jfr");
        assert_eq!(load(&path), list);
    }

    #[test]
    fn removing_an_absent_path_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = store(&dir);
        record_open(&path, "/a.jfr", 10, 1000).unwrap();
        let list = remove(&path, "/ghost.jfr").unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn clear_empties_the_list_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = store(&dir);
        record_open(&path, "/a.jfr", 10, 1000).unwrap();
        assert_eq!(clear(&path).unwrap(), vec![]);
        assert_eq!(load(&path), vec![]);
    }
}
