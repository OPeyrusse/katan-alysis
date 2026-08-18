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

/// A JVM flag captured at recording start: its value and where it came
/// from (`Command line`, `Ergonomic`, `Default`, ...).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnsignedFlag {
    pub value: u64,
    pub origin: String,
}

/// Boolean twin of [`UnsignedFlag`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BooleanFlag {
    pub value: bool,
    pub origin: String,
}

/// Metadata describing the recorded JVM, its GC and the host it ran on.
///
/// Every field is optional: a recording (an async-profiler one, or one
/// made with minimal settings) may carry none of the metadata events.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RecordingInfo {
    pub jvm_name: Option<String>,
    pub jvm_version: Option<String>,
    pub young_collector: Option<String>,
    pub old_collector: Option<String>,
    pub heap_max_bytes: Option<u64>,
    pub os_version: Option<String>,
    pub cpu_cores: Option<u32>,
    pub hw_threads: Option<u32>,
    pub physical_memory_bytes: Option<u64>,
    /// `-Xmx` (the `MaxHeapSize` flag).
    pub xmx: Option<UnsignedFlag>,
    /// `-Xms` (the `InitialHeapSize` flag).
    pub xms: Option<UnsignedFlag>,
    /// `-XX:MaxDirectMemorySize`, the direct off-heap ceiling.
    pub max_direct_memory: Option<UnsignedFlag>,
    /// `-XX:+DebugNonSafepoints`.
    pub debug_non_safepoints: Option<BooleanFlag>,
}

/// One point of a sampled signal (CPU load, heap occupancy, RSS...).
/// Timestamps are absolute epoch nanoseconds, like [`Sample::ts_nanos`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TimePoint {
    pub ts_nanos: i64,
    pub value: f64,
}

/// One garbage collection: when it started and how long it ran.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GcPause {
    pub ts_nanos: i64,
    pub duration_nanos: i64,
    /// Collector name, e.g. `G1New`.
    pub name: String,
    /// What triggered it, e.g. `G1 Evacuation Pause`.
    pub cause: String,
}

/// The periodic signals feeding the overview charts, each sorted by
/// timestamp and empty when the recording does not carry the event.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Signals {
    /// JVM user-mode CPU load, fraction of the machine (0..1).
    pub cpu_jvm_user: Vec<TimePoint>,
    /// JVM kernel-mode CPU load, fraction of the machine (0..1).
    pub cpu_jvm_system: Vec<TimePoint>,
    /// Whole-machine CPU load, fraction (0..1).
    pub cpu_machine_total: Vec<TimePoint>,
    /// Heap used, bytes (one point per GC heap summary).
    pub heap_used_bytes: Vec<TimePoint>,
    /// Heap committed, bytes.
    pub heap_committed_bytes: Vec<TimePoint>,
    /// Process resident set size, bytes.
    pub rss_bytes: Vec<TimePoint>,
    /// Garbage collections, sorted by start time.
    pub gc_pauses: Vec<GcPause>,
}

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
    /// JVM/GC/host metadata, when the recording carries it.
    pub info: RecordingInfo,
    /// Overview signals, when the recording carries them.
    pub signals: Signals,
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

/// One node of the flamegraph: a frame merged across every stack that
/// reaches it through the same ancestors, with the children continuing
/// the call chain beneath it. The tree is rooted synthetically above every
/// stack (`frame: None`, `samples` equal to the filtered sample count) so
/// that multiple entry points share one root.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FlameNode {
    /// The frame this node merges; `None` only for the synthetic root.
    pub frame: Option<FrameId>,
    /// Samples whose stack passes through this node.
    pub samples: u64,
    /// Children sorted by decreasing `samples`, ties broken by frame id so
    /// the tree is deterministic.
    pub children: Vec<FlameNode>,
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
    fn recording_info_defaults_to_all_unknown() {
        let info = RecordingInfo::default();
        assert_eq!(info.jvm_name, None);
        assert_eq!(info.xmx, None);
        assert_eq!(info.debug_non_safepoints, None);
        let json = serde_json::to_string(&info).unwrap();
        let back: RecordingInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back, info);
    }

    #[test]
    fn signals_round_trip_through_json() {
        let signals = Signals {
            cpu_jvm_user: vec![TimePoint {
                ts_nanos: 10,
                value: 0.5,
            }],
            gc_pauses: vec![GcPause {
                ts_nanos: 20,
                duration_nanos: 5,
                name: "G1New".into(),
                cause: "G1 Evacuation Pause".into(),
            }],
            ..Signals::default()
        };
        let json = serde_json::to_string(&signals).unwrap();
        let back: Signals = serde_json::from_str(&json).unwrap();
        assert_eq!(back, signals);
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
            ..Profile::default()
        };
        let json = serde_json::to_string(&profile).unwrap();
        let back: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(back, profile);
    }

    #[test]
    fn flame_node_round_trips_through_json_including_the_synthetic_root() {
        let tree = FlameNode {
            frame: None,
            samples: 3,
            children: vec![FlameNode {
                frame: Some(FrameId(0)),
                samples: 3,
                children: vec![],
            }],
        };
        let json = serde_json::to_string(&tree).unwrap();
        let back: FlameNode = serde_json::from_str(&json).unwrap();
        assert_eq!(back, tree);
    }
}
