//! Per-thread sample counts: how the thread panel orders and annotates its
//! entries. Unfiltered on purpose — the shares describe the recording, not
//! the current selection, so they stay stable while the analyst selects.

use jfr_model::Profile;

/// Sample count per thread, indexed like [`Profile::threads`].
pub fn thread_sample_counts(profile: &Profile) -> Vec<u64> {
    let mut counts = vec![0u64; profile.threads.len()];
    for sample in &profile.samples {
        if let Some(count) = counts.get_mut(sample.thread.0 as usize) {
            *count += 1;
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use jfr_model::{Sample, StackId, ThreadId, ThreadInfo};

    fn thread(id: u32, name: &str) -> ThreadInfo {
        ThreadInfo {
            id: ThreadId(id),
            name: name.into(),
        }
    }

    fn sample(ts_nanos: i64, thread: u32) -> Sample {
        Sample {
            ts_nanos,
            thread: ThreadId(thread),
            stack: StackId(0),
        }
    }

    #[test]
    fn counts_follow_the_thread_dictionary_order() {
        let profile = Profile {
            threads: vec![thread(0, "main"), thread(1, "worker")],
            samples: vec![sample(1, 1), sample(2, 1), sample(3, 0)],
            ..Profile::default()
        };
        assert_eq!(thread_sample_counts(&profile), vec![1, 2]);
    }

    #[test]
    fn a_thread_without_samples_counts_zero() {
        let profile = Profile {
            threads: vec![thread(0, "main"), thread(1, "idle")],
            samples: vec![sample(1, 0)],
            ..Profile::default()
        };
        assert_eq!(thread_sample_counts(&profile), vec![1, 0]);
    }

    #[test]
    fn an_empty_profile_has_no_counts() {
        assert_eq!(thread_sample_counts(&Profile::default()), Vec::<u64>::new());
    }
}
