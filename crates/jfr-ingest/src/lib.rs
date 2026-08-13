//! JFR ingestion: turns a raw JFR stream into a normalized [`Profile`].
//!
//! This is the only crate that depends on `jfrs`. It iterates chunks and
//! `jdk.ExecutionSample` events using the low-level API (the serde layer is
//! only used once per unique constant-pool entry, never per sample): stack
//! traces and threads arrive as constant-pool references, so they are
//! interned by pool index and decoded a single time each.

use std::collections::HashMap;
use std::io::{Read, Seek};

use jfr_model::{Frame, FrameId, Profile, Sample, StackId, ThreadId, ThreadInfo};
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
            if event.class.name() != EXECUTION_SAMPLE {
                continue;
            }
            let accessor = event.value();

            let Some(ticks) = long_field(&accessor, "startTime") else {
                continue;
            };
            let Some(stack) = intern_pooled(&accessor, "stackTrace", &mut stack_by_pool, |value| {
                interner.intern_stack(&chunk, value)
            }) else {
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
}

impl ProfileInterner {
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
        Ok(Profile {
            frames: self.frames,
            stacks: self.stacks,
            threads: self.threads,
            samples: self.samples,
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

/// Converts an event timestamp (chunk ticks) to nanoseconds since the epoch.
fn ticks_to_epoch_nanos(chunk: &Chunk, ticks: i64) -> i64 {
    let header = &chunk.header;
    let elapsed_ticks = (ticks - header.start_ticks) as i128;
    let nanos = elapsed_ticks * 1_000_000_000 / header.ticks_per_second as i128;
    header.start_time_nanos + nanos as i64
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
