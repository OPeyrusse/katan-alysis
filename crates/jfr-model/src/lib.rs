//! Shared data model for the JFR viewer.
//!
//! This crate defines the contract consumed by every other component:
//! normalized samples produced by `jfr-ingest`, and the ready-to-draw view
//! models produced by `jfr-aggregate`. Frames are shared by index (never by
//! string) so that views stay cheap to serialize and transform.

use serde::{Deserialize, Serialize};

/// Index into a profile's frame dictionary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FrameId(pub u32);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_id_serializes_as_bare_integer() {
        let json = serde_json::to_string(&FrameId(42)).unwrap();
        assert_eq!(json, "42");
        let back: FrameId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, FrameId(42));
    }
}
