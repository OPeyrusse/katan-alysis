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

/// Identifier of a sampled thread, stable within one profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ThreadId(pub u32);

/// One entry of the frame dictionary: a method, identified independently of
/// its position in any stack.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Frame {
    /// Fully qualified class name, e.g. `java.util.HashMap`.
    pub class_name: String,
    /// Method name, e.g. `resize`.
    pub method_name: String,
}

impl Frame {
    /// Display label, e.g. `java.util.HashMap.resize`.
    pub fn label(&self) -> String {
        format!("{}.{}", self.class_name, self.method_name)
    }
}

/// A thread observed in the recording.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadInfo {
    pub id: ThreadId,
    pub name: String,
}

/// One execution sample: a timestamp, the sampled thread, and the stack at
/// that instant. Frames are ordered root first (`main` at index 0, leaf last).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sample {
    /// Nanoseconds since the epoch.
    pub ts_nanos: i64,
    pub thread: ThreadId,
    /// Index into [`Profile::stacks`]; many samples share one stack.
    pub stack: StackId,
}

/// Index into a profile's stack dictionary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StackId(pub u32);

/// A normalized recording: everything the aggregation pipeline needs, and
/// nothing else. Produced once by `jfr-ingest`, then queried with filters.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    /// Frame dictionary; `FrameId` indexes into this.
    pub frames: Vec<Frame>,
    /// Stack dictionary; `StackId` indexes into this. Root-first frame ids.
    pub stacks: Vec<Vec<FrameId>>,
    /// Threads observed in the recording; `ThreadId` indexes into this.
    pub threads: Vec<ThreadInfo>,
    /// Samples ordered by timestamp.
    pub samples: Vec<Sample>,
}

impl Profile {
    /// Time range `[min, max]` of the samples, or `None` when empty.
    pub fn time_range_nanos(&self) -> Option<(i64, i64)> {
        let first = self.samples.first()?.ts_nanos;
        let last = self.samples.last()?.ts_nanos;
        Some((first, last))
    }
}

/// Cross-cutting filters, applied before any aggregation.
///
/// An empty filter is not a filter: `None`, an empty thread list and an
/// empty time range all mean "keep everything" for that category. The
/// analyst who deselects every thread is not asking to see nothing, and
/// the two categories stay independent — an empty thread selection leaves
/// an active time range alone.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Filters {
    /// Keep only samples from these threads; empty means every thread.
    pub threads: Option<Vec<ThreadId>>,
    /// Keep only samples with `start <= ts_nanos < end`; a range holding
    /// no instant (`end <= start`) means the whole recording.
    pub time_range_nanos: Option<(i64, i64)>,
}

impl Filters {
    pub fn accepts(&self, sample: &Sample) -> bool {
        if let Some(threads) = &self.threads
            && !threads.is_empty()
            && !threads.contains(&sample.thread)
        {
            return false;
        }
        if let Some((start, end)) = self.time_range_nanos
            && start < end
            && (sample.ts_nanos < start || sample.ts_nanos >= end)
        {
            return false;
        }
        true
    }
}

/// Sample counts over uniform time buckets: the density strip drawn under
/// the timeline brush. Bucket `i` covers recording-relative nanoseconds
/// `[i * bucket_nanos, (i + 1) * bucket_nanos)`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SampleDensity {
    /// Width of one bucket; `0` when the profile holds no sample.
    pub bucket_nanos: i64,
    pub counts: Vec<u64>,
}

/// Flat-profile statistics for one method (the "top methods" view).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MethodStats {
    /// Samples where the method is the leaf (on-CPU itself).
    pub self_samples: u64,
    /// Samples where the method appears anywhere in the stack, counted once
    /// per sample even for recursive stacks.
    pub total_samples: u64,
}

/// The "top methods" view model: per-method stats plus the sample count that
/// survived the filters (denominator for percentages).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TopMethods {
    /// `(frame, stats)` sorted by decreasing `self_samples`.
    pub rows: Vec<(FrameId, MethodStats)>,
    pub total_samples: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(ts_nanos: i64, thread: u32, stack: u32) -> Sample {
        Sample {
            ts_nanos,
            thread: ThreadId(thread),
            stack: StackId(stack),
        }
    }

    #[test]
    fn frame_id_serializes_as_bare_integer() {
        let json = serde_json::to_string(&FrameId(42)).unwrap();
        assert_eq!(json, "42");
        let back: FrameId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, FrameId(42));
    }

    #[test]
    fn frame_label_joins_class_and_method() {
        let frame = Frame {
            class_name: "java.util.HashMap".into(),
            method_name: "resize".into(),
        };
        assert_eq!(frame.label(), "java.util.HashMap.resize");
    }

    #[test]
    fn empty_profile_has_no_time_range() {
        assert_eq!(Profile::default().time_range_nanos(), None);
    }

    #[test]
    fn time_range_spans_first_to_last_sample() {
        let profile = Profile {
            samples: vec![sample(10, 0, 0), sample(25, 0, 0), sample(40, 0, 0)],
            ..Profile::default()
        };
        assert_eq!(profile.time_range_nanos(), Some((10, 40)));
    }

    #[test]
    fn default_filters_accept_everything() {
        assert!(Filters::default().accepts(&sample(123, 7, 0)));
    }

    #[test]
    fn thread_filter_keeps_only_listed_threads() {
        let filters = Filters {
            threads: Some(vec![ThreadId(1), ThreadId(3)]),
            ..Filters::default()
        };
        assert!(filters.accepts(&sample(0, 1, 0)));
        assert!(filters.accepts(&sample(0, 3, 0)));
        assert!(!filters.accepts(&sample(0, 2, 0)));
    }

    #[test]
    fn an_empty_thread_list_filters_nothing() {
        let filters = Filters {
            threads: Some(vec![]),
            ..Filters::default()
        };
        assert!(filters.accepts(&sample(0, 1, 0)));
        assert!(filters.accepts(&sample(0, 2, 0)));
    }

    #[test]
    fn an_empty_thread_list_leaves_the_time_filter_alone() {
        let filters = Filters {
            threads: Some(vec![]),
            time_range_nanos: Some((10, 20)),
        };
        assert!(filters.accepts(&sample(15, 7, 0)));
        assert!(!filters.accepts(&sample(25, 7, 0)));
    }

    #[test]
    fn an_empty_time_range_filters_nothing() {
        for range in [(10, 10), (20, 10)] {
            let filters = Filters {
                time_range_nanos: Some(range),
                ..Filters::default()
            };
            assert!(filters.accepts(&sample(0, 0, 0)), "range {range:?}");
            assert!(filters.accepts(&sample(15, 0, 0)), "range {range:?}");
        }
    }

    #[test]
    fn an_empty_time_range_leaves_the_thread_filter_alone() {
        let filters = Filters {
            threads: Some(vec![ThreadId(1)]),
            time_range_nanos: Some((20, 10)),
        };
        assert!(filters.accepts(&sample(0, 1, 0)));
        assert!(!filters.accepts(&sample(0, 2, 0)));
    }

    #[test]
    fn time_filter_is_half_open() {
        let filters = Filters {
            time_range_nanos: Some((10, 20)),
            ..Filters::default()
        };
        assert!(!filters.accepts(&sample(9, 0, 0)));
        assert!(filters.accepts(&sample(10, 0, 0)));
        assert!(filters.accepts(&sample(19, 0, 0)));
        assert!(!filters.accepts(&sample(20, 0, 0)));
    }

    #[test]
    fn profile_round_trips_through_json() {
        let profile = Profile {
            frames: vec![Frame {
                class_name: "Main".into(),
                method_name: "main".into(),
            }],
            stacks: vec![vec![FrameId(0)]],
            threads: vec![ThreadInfo {
                id: ThreadId(0),
                name: "main".into(),
            }],
            samples: vec![sample(1, 0, 0)],
        };
        let json = serde_json::to_string(&profile).unwrap();
        let back: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(back, profile);
    }
}
