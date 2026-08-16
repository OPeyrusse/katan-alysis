//! JFR ingestion: turns a raw JFR stream into a normalized [`Profile`].
//!
//! This is the only crate that depends on `jfrs`. It iterates chunks and
//! `jdk.ExecutionSample` events using the low-level API (the serde layer is
//! only used once per unique constant-pool entry, never per sample): stack
//! traces and threads arrive as constant-pool references, so they are
//! interned by pool index and decoded a single time each.
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
use jfrs::reader::types::builtin::{JdkThread, StackTrace};
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

        for event in chunk_reader.events(&chunk) {
            let event = event.map_err(parse_error)?;
            let name = event.class.name();
            if name == EXECUTION_SAMPLE {
                let accessor = event.value();

                let Some(ticks) = long_field(&accessor, "startTime") else {
                    continue;
                };
                let Some(stack) =
                    intern_pooled(&accessor, "stackTrace", &mut stack_by_pool, |value| {
                        interner.intern_stack(&chunk, value)
                    })
                else {
                    continue;
                };
                let Some(thread) =
                    intern_pooled(&accessor, "sampledThread", &mut thread_by_pool, |value| {
                        interner.intern_thread(&chunk, value)
                    })
                else {
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
    }

    interner.into_profile()
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
        let trace: StackTrace = jfrs::reader::de::from_value_descriptor(chunk, value).ok()?;
        // JFR stores stacks leaf-first; the model wants root-first.
        let mut frame_ids: Vec<FrameId> = trace
            .frames
            .iter()
            .flatten()
            .map(|frame| {
                let method = frame.method.as_ref();
                let class_name = method
                    .and_then(|m| m.class.as_ref())
                    .and_then(|c| c.name.as_ref())
                    .and_then(|s| s.string)
                    .unwrap_or("<unknown>")
                    .replace('/', ".");
                let method_name = method
                    .and_then(|m| m.name.as_ref())
                    .and_then(|s| s.string)
                    .unwrap_or("<unknown>")
                    .to_owned();
                self.intern_frame(Frame {
                    class_name,
                    method_name,
                })
            })
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

    fn intern_frame(&mut self, frame: Frame) -> FrameId {
        *self.frame_ids.entry(frame).or_insert_with_key(|key| {
            self.frames.push(key.clone());
            FrameId((self.frames.len() - 1) as u32)
        })
    }

    fn intern_thread(&mut self, chunk: &Chunk, value: &ValueDescriptor) -> Option<ThreadId> {
        let thread: JdkThread = jfrs::reader::de::from_value_descriptor(chunk, value).ok()?;
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
fn intern_pooled<T: Copy>(
    accessor: &Accessor<'_>,
    field: &str,
    cache: &mut HashMap<i64, Option<T>>,
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
    let interned = raw.resolve().and_then(|resolved| intern(resolved.value));
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
