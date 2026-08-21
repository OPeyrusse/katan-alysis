//! JFR ingestion: turns a raw JFR stream into a normalized [`Profile`].
//!
//! This is the only crate that depends on `jfrs`. It iterates chunks and
//! `jdk.ExecutionSample` events using the low-level `Accessor` API, and
//! threads and stacks arrive as constant-pool references, so they are
//! interned by pool index and decoded a single time each. Threads are
//! decoded through `jfrs`'s serde layer (every field of `JdkThread` is
//! optional, so a missing nested constant-pool entry degrades to `None`
//! rather than failing the whole thread). Stacks are walked frame by frame
//! through `Accessor` instead: `jfrs`'s `StackTrace`/`Method`/`Class` serde
//! types have non-optional nested fields (e.g. a module's location), so one
//! unresolvable constant-pool entry anywhere in a frame's method/class chain
//! would otherwise fail the *entire* stack trace, silently dropping the
//! sample — `Accessor` resolves each hop independently and falls back to
//! `"<unknown>"` for the piece that is missing.
//!
//! Beyond the samples, the reader collects the recording's metadata (JVM,
//! GC and OS description, a few key flags) and the periodic signals of the
//! overview (CPU load, heap occupancy, RSS, GC pauses). All of it is
//! optional: a recording may carry none of those events.

use std::collections::HashMap;
use std::io::{Read, Seek};

use jfr_model::{
    BooleanFlag, Frame, FrameId, GcPause, Profile, Sample, StackId, ThreadId, ThreadInfo,
    TimePoint, UnsignedFlag,
};
use jfrs::reader::event::Accessor;
use jfrs::reader::types::builtin::JdkThread;
use jfrs::reader::value_descriptor::{Primitive, ValueDescriptor};
use jfrs::reader::{Chunk, JfrReader};

const EXECUTION_SAMPLE: &str = "jdk.ExecutionSample";

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("failed to parse JFR stream: {0}")]
    Parse(String),
}

/// Reads every `jdk.ExecutionSample` event of the stream into a [`Profile`].
///
/// Samples without a resolvable stack trace or thread are skipped: they
/// cannot contribute to any view. Samples are returned sorted by timestamp.
pub fn read_profile<R: Read + Seek>(source: R) -> Result<Profile, IngestError> {
    let mut reader = JfrReader::new(source);
    let mut interner = ProfileInterner::default();

    for chunk in reader.chunks() {
        let (mut chunk_reader, chunk) = chunk.map_err(parse_error)?;
        // Constant-pool indices are only meaningful within one chunk.
        let mut stack_by_pool: HashMap<i64, Option<StackId>> = HashMap::new();
        let mut thread_by_pool: HashMap<i64, Option<ThreadId>> = HashMap::new();
        let mut stack_pool_unresolved = 0usize;
        let mut thread_pool_unresolved = 0usize;

        for event in chunk_reader.events(&chunk) {
            let event = event.map_err(parse_error)?;
            let name = event.class.name();
            if name == EXECUTION_SAMPLE {
                interner.diagnostics.execution_samples_seen += 1;
                let accessor = event.value();

                let Some(ticks) = long_field(&accessor, "startTime") else {
                    interner.diagnostics.samples_missing_start_time += 1;
                    continue;
                };
                let Some(stack) = intern_pooled(
                    &accessor,
                    "stackTrace",
                    &mut stack_by_pool,
                    &mut stack_pool_unresolved,
                    |value| interner.intern_stack(&chunk, value),
                ) else {
                    interner.diagnostics.samples_missing_stack += 1;
                    continue;
                };
                let Some(thread) = intern_pooled(
                    &accessor,
                    "sampledThread",
                    &mut thread_by_pool,
                    &mut thread_pool_unresolved,
                    |value| interner.intern_thread(&chunk, value),
                ) else {
                    interner.diagnostics.samples_missing_thread += 1;
                    continue;
                };

                interner.samples.push(Sample {
                    ts_nanos: ticks_to_epoch_nanos(&chunk, ticks),
                    thread,
                    stack,
                });
            } else {
                interner.collect_metadata(&chunk, name, &event.value());
            }
        }

        interner.diagnostics.stack_pool_unresolved += stack_pool_unresolved;
        interner.diagnostics.thread_pool_unresolved += thread_pool_unresolved;
    }

    interner.log_diagnostics();
    interner.into_profile()
}

/// Counts of samples and constant-pool entries that could not be used, kept
/// purely for diagnosing recordings that ingest with fewer threads or
/// samples than expected. Logged to stderr, never surfaced in the `Profile`.
#[derive(Default)]
struct Diagnostics {
    execution_samples_seen: usize,
    samples_missing_start_time: usize,
    samples_missing_stack: usize,
    samples_missing_thread: usize,
    stack_pool_unresolved: usize,
    thread_pool_unresolved: usize,
    thread_decode_failures: usize,
}

/// Accumulates the dictionaries of a profile while chunks are being read.
#[derive(Default)]
struct ProfileInterner {
    frames: Vec<Frame>,
    frame_ids: HashMap<Frame, FrameId>,
    stacks: Vec<Vec<FrameId>>,
    stack_ids: HashMap<Vec<FrameId>, StackId>,
    threads: Vec<ThreadInfo>,
    thread_ids: HashMap<(i64, i64, String), ThreadId>,
    samples: Vec<Sample>,
    info: jfr_model::RecordingInfo,
    signals: jfr_model::Signals,
    diagnostics: Diagnostics,
}

impl ProfileInterner {
    /// Collects the non-sample events feeding the overview: metadata is
    /// last-writer-wins (one event per chunk), signals accumulate.
    fn collect_metadata(&mut self, chunk: &Chunk, name: &str, accessor: &Accessor<'_>) {
        let ts = |field: &str| long_field(accessor, field).map(|t| ticks_to_epoch_nanos(chunk, t));
        match name {
            "jdk.CPULoad" => {
                let Some(ts_nanos) = ts("startTime") else {
                    return;
                };
                let point = |field: &str, series: &mut Vec<TimePoint>| {
                    if let Some(value) = float_field(accessor, field) {
                        series.push(TimePoint {
                            ts_nanos,
                            value: value as f64,
                        });
                    }
                };
                point("jvmUser", &mut self.signals.cpu_jvm_user);
                point("jvmSystem", &mut self.signals.cpu_jvm_system);
                point("machineTotal", &mut self.signals.cpu_machine_total);
            }
            "jdk.GCHeapSummary" => {
                let Some(ts_nanos) = ts("startTime") else {
                    return;
                };
                if let Some(used) = long_field(accessor, "heapUsed") {
                    self.signals.heap_used_bytes.push(TimePoint {
                        ts_nanos,
                        value: used as f64,
                    });
                }
                if let Some(committed) = accessor
                    .get_field("heapSpace")
                    .and_then(|space| long_field(&space, "committedSize"))
                {
                    self.signals.heap_committed_bytes.push(TimePoint {
                        ts_nanos,
                        value: committed as f64,
                    });
                }
            }
            "jdk.ResidentSetSize" => {
                if let (Some(ts_nanos), Some(size)) =
                    (ts("startTime"), long_field(accessor, "size"))
                {
                    self.signals.rss_bytes.push(TimePoint {
                        ts_nanos,
                        value: size as f64,
                    });
                }
            }
            "jdk.GarbageCollection" => {
                let (Some(ts_nanos), Some(duration)) =
                    (ts("startTime"), long_field(accessor, "duration"))
                else {
                    return;
                };
                self.signals.gc_pauses.push(GcPause {
                    ts_nanos,
                    duration_nanos: ticks_to_duration_nanos(chunk, duration),
                    name: string_field(accessor, "name").unwrap_or_default(),
                    cause: string_field(accessor, "cause").unwrap_or_default(),
                });
            }
            "jdk.JVMInformation" => {
                self.info.jvm_name = string_field(accessor, "jvmName");
                self.info.jvm_version = string_field(accessor, "jvmVersion");
            }
            "jdk.OSInformation" => {
                self.info.os_version = string_field(accessor, "osVersion");
            }
            "jdk.CPUInformation" => {
                self.info.cpu_cores = int_field(accessor, "cores").map(|v| v as u32);
                self.info.hw_threads = int_field(accessor, "hwThreads").map(|v| v as u32);
            }
            "jdk.GCConfiguration" => {
                self.info.young_collector = string_field(accessor, "youngCollector");
                self.info.old_collector = string_field(accessor, "oldCollector");
            }
            "jdk.GCHeapConfiguration" => {
                self.info.heap_max_bytes = long_field(accessor, "maxSize").map(|v| v as u64);
            }
            "jdk.PhysicalMemory" => {
                self.info.physical_memory_bytes =
                    long_field(accessor, "totalSize").map(|v| v as u64);
            }
            "jdk.UnsignedLongFlag" => {
                let slot = match string_field(accessor, "name").as_deref() {
                    Some("MaxHeapSize") => &mut self.info.xmx,
                    Some("InitialHeapSize") => &mut self.info.xms,
                    Some("MaxDirectMemorySize") => &mut self.info.max_direct_memory,
                    _ => return,
                };
                if let (Some(value), Some(origin)) = (
                    long_field(accessor, "value"),
                    string_field(accessor, "origin"),
                ) {
                    *slot = Some(UnsignedFlag {
                        value: value as u64,
                        origin,
                    });
                }
            }
            "jdk.BooleanFlag" => {
                if string_field(accessor, "name").as_deref() != Some("DebugNonSafepoints") {
                    return;
                }
                if let (Some(value), Some(origin)) = (
                    bool_field(accessor, "value"),
                    string_field(accessor, "origin"),
                ) {
                    self.info.debug_non_safepoints = Some(BooleanFlag { value, origin });
                }
            }
            _ => {}
        }
    }
    fn intern_stack(&mut self, chunk: &Chunk, value: &ValueDescriptor) -> Option<StackId> {
        let accessor = Accessor::new(chunk, value);
        let frames = accessor.get_field("frames")?.as_iter()?;

        // JFR stores stacks leaf-first; the model wants root-first. A frame
        // whose method/class name can't be resolved (a constant-pool entry
        // missing from this chunk, e.g. an unrecorded module location) still
        // counts as a frame, just an unnamed one: dropping it would shrink
        // the stack instead of just leaving a gap in its labels.
        let mut frame_ids: Vec<FrameId> = frames
            .map(|frame| self.intern_stack_frame(&frame))
            .collect();
        frame_ids.reverse();
        if frame_ids.is_empty() {
            return None;
        }
        Some(*self.stack_ids.entry(frame_ids).or_insert_with_key(|key| {
            self.stacks.push(key.clone());
            StackId((self.stacks.len() - 1) as u32)
        }))
    }

    fn intern_stack_frame(&mut self, frame: &Accessor<'_>) -> FrameId {
        let method = frame.get_field("method");
        let class_name = method
            .as_ref()
            .and_then(|m| m.get_field("type"))
            .and_then(|class| symbol_field(&class, "name"))
            .unwrap_or("<unknown>")
            .replace('/', ".");
        let method_name = method
            .as_ref()
            .and_then(|m| symbol_field(m, "name"))
            .unwrap_or("<unknown>")
            .to_owned();
        self.intern_frame(Frame {
            class_name,
            method_name,
        })
    }

    fn intern_frame(&mut self, frame: Frame) -> FrameId {
        *self.frame_ids.entry(frame).or_insert_with_key(|key| {
            self.frames.push(key.clone());
            FrameId((self.frames.len() - 1) as u32)
        })
    }

    fn intern_thread(&mut self, chunk: &Chunk, value: &ValueDescriptor) -> Option<ThreadId> {
        let thread: JdkThread = match jfrs::reader::de::from_value_descriptor(chunk, value) {
            Ok(thread) => thread,
            Err(err) => {
                self.diagnostics.thread_decode_failures += 1;
                eprintln!(
                    "jfr-ingest: failed to decode a sampledThread constant-pool entry as JdkThread: {err} (raw value: {value:?})"
                );
                return None;
            }
        };
        let name = thread
            .java_name
            .or(thread.os_name)
            .unwrap_or("<unknown>")
            .to_owned();
        let key = (thread.java_thread_id, thread.os_thread_id, name);
        Some(*self.thread_ids.entry(key).or_insert_with_key(|key| {
            let id = ThreadId(self.threads.len() as u32);
            self.threads.push(ThreadInfo {
                id,
                name: key.2.clone(),
            });
            id
        }))
    }

    /// Prints a one-line summary to stderr when any sample or constant-pool
    /// entry was dropped during ingestion, to help diagnose recordings that
    /// come out with fewer threads or samples than expected.
    fn log_diagnostics(&self) {
        let d = &self.diagnostics;
        let kept = self.samples.len();
        let dropped = d.execution_samples_seen.saturating_sub(kept);
        if dropped == 0 && d.stack_pool_unresolved == 0 && d.thread_pool_unresolved == 0 {
            return;
        }
        eprintln!(
            "jfr-ingest: {} {EXECUTION_SAMPLE} seen, {kept} kept, {dropped} dropped \
             (missing startTime: {}, missing stack: {}, missing thread: {}; \
             unresolved constant-pool refs: stack {}, thread {}; \
             thread decode failures: {}); {} distinct threads resolved",
            d.execution_samples_seen,
            d.samples_missing_start_time,
            d.samples_missing_stack,
            d.samples_missing_thread,
            d.stack_pool_unresolved,
            d.thread_pool_unresolved,
            d.thread_decode_failures,
            self.threads.len(),
        );
    }

    fn into_profile(mut self) -> Result<Profile, IngestError> {
        if self.samples.is_empty() {
            return Err(IngestError::Parse(format!(
                "no usable {EXECUTION_SAMPLE} event found in the recording"
            )));
        }
        self.samples.sort_by_key(|s| s.ts_nanos);
        for series in [
            &mut self.signals.cpu_jvm_user,
            &mut self.signals.cpu_jvm_system,
            &mut self.signals.cpu_machine_total,
            &mut self.signals.heap_used_bytes,
            &mut self.signals.heap_committed_bytes,
            &mut self.signals.rss_bytes,
        ] {
            series.sort_by_key(|p| p.ts_nanos);
        }
        self.signals.gc_pauses.sort_by_key(|p| p.ts_nanos);
        Ok(Profile {
            frames: self.frames,
            stacks: self.stacks,
            threads: self.threads,
            samples: self.samples,
            info: self.info,
            signals: self.signals,
        })
    }
}

/// Reads a constant-pool field, interning it at most once per pool index.
/// `unresolved` counts pool indices that could not be resolved at all (the
/// checkpoint carrying that entry was never seen in this chunk).
fn intern_pooled<T: Copy>(
    accessor: &Accessor<'_>,
    field: &str,
    cache: &mut HashMap<i64, Option<T>>,
    unresolved: &mut usize,
    mut intern: impl FnMut(&ValueDescriptor) -> Option<T>,
) -> Option<T> {
    let raw = accessor.get_field_raw(field)?;
    let ValueDescriptor::ConstantPool { constant_index, .. } = raw.value else {
        // Not pooled in this recording: intern the inline value directly.
        return intern(raw.value);
    };
    let key = *constant_index;
    if let Some(cached) = cache.get(&key) {
        return *cached;
    }
    let Some(resolved) = raw.resolve() else {
        *unresolved += 1;
        eprintln!(
            "jfr-ingest: constant-pool index {key} for field {field:?} could not be resolved \
             (no matching checkpoint in this chunk)"
        );
        cache.insert(key, None);
        return None;
    };
    let interned = intern(resolved.value);
    cache.insert(key, interned);
    interned
}

fn long_field(accessor: &Accessor<'_>, field: &str) -> Option<i64> {
    match accessor.get_field(field)?.value {
        ValueDescriptor::Primitive(Primitive::Long(v)) => Some(*v),
        _ => None,
    }
}

fn int_field(accessor: &Accessor<'_>, field: &str) -> Option<i32> {
    match accessor.get_field(field)?.value {
        ValueDescriptor::Primitive(Primitive::Integer(v)) => Some(*v),
        _ => None,
    }
}

fn float_field(accessor: &Accessor<'_>, field: &str) -> Option<f32> {
    match accessor.get_field(field)?.value {
        ValueDescriptor::Primitive(Primitive::Float(v)) => Some(*v),
        _ => None,
    }
}

fn bool_field(accessor: &Accessor<'_>, field: &str) -> Option<bool> {
    match accessor.get_field(field)?.value {
        ValueDescriptor::Primitive(Primitive::Boolean(v)) => Some(*v),
        _ => None,
    }
}

/// Reads a `Symbol`-typed field (class, method and package names all
/// resolve through this constant-pool type: an object wrapping one string).
fn symbol_field<'a>(accessor: &Accessor<'a>, field: &str) -> Option<&'a str> {
    match accessor.get_field(field)?.get_field("string")?.value {
        ValueDescriptor::Primitive(Primitive::String(v)) => Some(v.as_str()),
        _ => None,
    }
}

/// Reads a string-valued field. String-like JFR types (a GC name or cause,
/// a flag origin) are objects wrapping a single string field; unwrap them.
fn string_field(accessor: &Accessor<'_>, field: &str) -> Option<String> {
    match accessor.get_field(field)?.value {
        ValueDescriptor::Primitive(Primitive::String(v)) => Some(v.clone()),
        ValueDescriptor::Object(object) => match object.fields.as_slice() {
            [ValueDescriptor::Primitive(Primitive::String(v))] => Some(v.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Converts an event timestamp (chunk ticks) to nanoseconds since the epoch.
fn ticks_to_epoch_nanos(chunk: &Chunk, ticks: i64) -> i64 {
    let header = &chunk.header;
    let elapsed_ticks = (ticks - header.start_ticks) as i128;
    let nanos = elapsed_ticks * 1_000_000_000 / header.ticks_per_second as i128;
    header.start_time_nanos + nanos as i64
}

/// Converts a duration expressed in chunk ticks to nanoseconds.
fn ticks_to_duration_nanos(chunk: &Chunk, ticks: i64) -> i64 {
    let nanos = ticks as i128 * 1_000_000_000 / chunk.header.ticks_per_second as i128;
    nanos as i64
}

fn parse_error(error: jfrs::reader::Error) -> IngestError {
    IngestError::Parse(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn rejects_a_non_jfr_stream() {
        let err =
            read_profile(Cursor::new(b"definitely not a flight recording".to_vec())).unwrap_err();
        assert!(err.to_string().starts_with("failed to parse JFR stream"));
    }

    #[test]
    fn rejects_a_truncated_stream() {
        // A valid magic ("FLR\0") followed by nothing.
        let err = read_profile(Cursor::new(b"FLR\0".to_vec())).unwrap_err();
        assert!(matches!(err, IngestError::Parse(_)));
    }

    #[test]
    fn a_recording_without_samples_is_an_error() {
        let err = ProfileInterner::default().into_profile().unwrap_err();
        assert!(err.to_string().contains("jdk.ExecutionSample"));
    }
}
