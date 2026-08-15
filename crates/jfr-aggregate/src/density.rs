//! Sample density over time: the context strip under the timeline brush.
//!
//! Deliberately unfiltered — the strip shows the whole recording so the
//! analyst can see where the current window sits, so it is computed once
//! per recording, not once per selection.

use jfr_model::{Profile, SampleDensity};

/// Buckets the samples into at most `buckets` uniform time slices spanning
/// the whole recording.
pub fn sample_density(profile: &Profile, buckets: usize) -> SampleDensity {
    let Some((start, end)) = profile.time_range_nanos() else {
        return SampleDensity::default();
    };
    let buckets = buckets.max(1) as i64;
    // Half-open buckets over an inclusive sample range: stretch the span by
    // one nanosecond so the last sample lands inside the last bucket.
    let span = end - start + 1;
    let bucket_nanos = (span + buckets - 1) / buckets;
    let mut counts = vec![0u64; ((span + bucket_nanos - 1) / bucket_nanos) as usize];
    for sample in &profile.samples {
        counts[((sample.ts_nanos - start) / bucket_nanos) as usize] += 1;
    }
    SampleDensity {
        bucket_nanos,
        counts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jfr_model::{Sample, StackId, ThreadId};

    fn profile_with_samples(ts: &[i64]) -> Profile {
        Profile {
            samples: ts
                .iter()
                .map(|&ts_nanos| Sample {
                    ts_nanos,
                    thread: ThreadId(0),
                    stack: StackId(0),
                })
                .collect(),
            ..Profile::default()
        }
    }

    #[test]
    fn an_empty_profile_has_an_empty_density() {
        assert_eq!(
            sample_density(&Profile::default(), 10),
            SampleDensity::default()
        );
    }

    #[test]
    fn every_sample_lands_in_exactly_one_bucket() {
        let profile = profile_with_samples(&[0, 10, 25, 49, 50, 99]);
        let density = sample_density(&profile, 4);
        assert_eq!(density.bucket_nanos, 25);
        assert_eq!(density.counts, vec![2, 2, 1, 1]);
        assert_eq!(
            density.counts.iter().sum::<u64>(),
            profile.samples.len() as u64
        );
    }

    #[test]
    fn the_last_sample_lands_in_the_last_bucket() {
        let profile = profile_with_samples(&[0, 100]);
        let density = sample_density(&profile, 10);
        assert_eq!(density.counts.len(), 10);
        assert_eq!(*density.counts.last().unwrap(), 1);
    }

    #[test]
    fn a_single_instant_recording_fits_one_bucket() {
        let profile = profile_with_samples(&[42, 42, 42]);
        let density = sample_density(&profile, 8);
        assert_eq!(density.counts, vec![3]);
        assert_eq!(density.bucket_nanos, 1);
    }

    #[test]
    fn buckets_never_exceed_the_requested_count() {
        // A span that does not divide evenly: 7 nanoseconds over 3 buckets.
        let profile = profile_with_samples(&[0, 3, 6]);
        let density = sample_density(&profile, 3);
        assert!(density.counts.len() <= 3);
        assert_eq!(density.counts.iter().sum::<u64>(), 3);
    }

    #[test]
    fn timestamps_are_bucketed_relative_to_the_first_sample() {
        // Offsets 0, 50 and 99 over two 50 ns buckets: [0, 50) and [50, 100).
        let profile = profile_with_samples(&[1_000_000, 1_000_050, 1_000_099]);
        let density = sample_density(&profile, 2);
        assert_eq!(density.counts, vec![1, 2]);
    }
}
