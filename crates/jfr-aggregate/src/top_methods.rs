//! Flat profile: per-method self/total sample counts.

use std::collections::{HashMap, HashSet};

use jfr_model::{Filters, FrameId, MethodStats, Profile, TopMethods};

/// Builds the "top methods" view from the filtered samples.
///
/// `self_samples` counts samples where the method is the leaf frame;
/// `total_samples` counts samples where it appears anywhere in the stack,
/// at most once per sample even when the stack is recursive. Rows are
/// sorted by decreasing self count (ties broken by total, then frame id,
/// so the output is deterministic).
pub fn top_methods(profile: &Profile, filters: &Filters) -> TopMethods {
    let (stack_counts, total_samples) = super::stack_counts(profile, filters);

    let mut stats: HashMap<FrameId, MethodStats> = HashMap::new();
    let mut seen: HashSet<FrameId> = HashSet::new();
    for (stack_id, count) in stack_counts {
        let frames = &profile.stacks[stack_id.0 as usize];
        if let Some(leaf) = frames.last() {
            stats.entry(*leaf).or_default().self_samples += count;
        }
        seen.clear();
        for frame in frames {
            if seen.insert(*frame) {
                stats.entry(*frame).or_default().total_samples += count;
            }
        }
    }

    let mut rows: Vec<(FrameId, MethodStats)> = stats.into_iter().collect();
    rows.sort_by(|(id_a, a), (id_b, b)| {
        b.self_samples
            .cmp(&a.self_samples)
            .then(b.total_samples.cmp(&a.total_samples))
            .then(id_a.cmp(id_b))
    });

    TopMethods {
        rows,
        total_samples,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jfr_model::{Frame, Sample, StackId, ThreadId, ThreadInfo};

    /// Builds a profile from `(ts, thread, stack)` samples over stacks given
    /// as frame-index lists; frames are named `f0`, `f1`, ...
    fn profile(frame_count: u32, stacks: &[&[u32]], samples: &[(i64, u32, u32)]) -> Profile {
        Profile {
            frames: (0..frame_count)
                .map(|i| Frame {
                    class_name: "Test".into(),
                    method_name: format!("f{i}"),
                })
                .collect(),
            stacks: stacks
                .iter()
                .map(|s| s.iter().map(|&i| FrameId(i)).collect())
                .collect(),
            threads: vec![
                ThreadInfo {
                    id: ThreadId(0),
                    name: "t0".into(),
                },
                ThreadInfo {
                    id: ThreadId(1),
                    name: "t1".into(),
                },
            ],
            samples: samples
                .iter()
                .map(|&(ts_nanos, thread, stack)| Sample {
                    ts_nanos,
                    thread: ThreadId(thread),
                    stack: StackId(stack),
                })
                .collect(),
            ..Profile::default()
        }
    }

    fn stats_of(view: &TopMethods, frame: u32) -> MethodStats {
        view.rows
            .iter()
            .find(|(id, _)| *id == FrameId(frame))
            .map(|(_, stats)| *stats)
            .unwrap_or_default()
    }

    #[test]
    fn self_counts_leaves_and_total_counts_presence() {
        // Two call paths 0->1->2 and 0->3, plus a lone leaf 2.
        let profile = profile(
            4,
            &[&[0, 1, 2], &[0, 3], &[2]],
            &[(1, 0, 0), (2, 0, 0), (3, 0, 1), (4, 0, 2)],
        );
        let view = top_methods(&profile, &Filters::default());

        assert_eq!(view.total_samples, 4);
        assert_eq!(stats_of(&view, 0).self_samples, 0);
        assert_eq!(stats_of(&view, 0).total_samples, 3);
        assert_eq!(stats_of(&view, 2).self_samples, 3);
        assert_eq!(stats_of(&view, 2).total_samples, 3);
        assert_eq!(stats_of(&view, 3).self_samples, 1);
        assert_eq!(stats_of(&view, 3).total_samples, 1);
    }

    #[test]
    fn recursive_frames_count_once_per_sample() {
        // Stack 0 -> 1 -> 0 -> 1: both methods appear twice in the stack.
        let profile = profile(2, &[&[0, 1, 0, 1]], &[(1, 0, 0), (2, 0, 0)]);
        let view = top_methods(&profile, &Filters::default());

        assert_eq!(stats_of(&view, 0).total_samples, 2);
        assert_eq!(stats_of(&view, 1).total_samples, 2);
        assert_eq!(stats_of(&view, 1).self_samples, 2);
    }

    #[test]
    fn self_never_exceeds_total_and_totals_are_bounded() {
        let profile = profile(
            4,
            &[&[0, 1, 2], &[0, 3], &[2]],
            &[(1, 0, 0), (2, 1, 1), (3, 0, 2), (4, 1, 0)],
        );
        let view = top_methods(&profile, &Filters::default());
        let self_sum: u64 = view.rows.iter().map(|(_, s)| s.self_samples).sum();
        assert_eq!(self_sum, view.total_samples);
        for (_, stats) in &view.rows {
            assert!(stats.self_samples <= stats.total_samples);
            assert!(stats.total_samples <= view.total_samples);
        }
    }

    #[test]
    fn rows_are_sorted_by_decreasing_self_count() {
        let profile = profile(
            4,
            &[&[0, 1, 2], &[0, 3], &[2]],
            &[(1, 0, 0), (2, 0, 2), (3, 0, 2), (4, 0, 1)],
        );
        let view = top_methods(&profile, &Filters::default());
        let selfs: Vec<u64> = view.rows.iter().map(|(_, s)| s.self_samples).collect();
        let mut sorted = selfs.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(selfs, sorted);
        assert_eq!(view.rows[0].0, FrameId(2));
    }

    #[test]
    fn thread_filter_restricts_the_aggregation() {
        let profile = profile(3, &[&[0, 1], &[0, 2]], &[(1, 0, 0), (2, 1, 1), (3, 1, 1)]);
        let filters = Filters {
            threads: Some(vec![ThreadId(1)]),
            ..Filters::default()
        };
        let view = top_methods(&profile, &filters);

        assert_eq!(view.total_samples, 2);
        assert_eq!(stats_of(&view, 2).self_samples, 2);
        assert_eq!(stats_of(&view, 1).total_samples, 0);
    }

    #[test]
    fn time_filter_restricts_the_aggregation() {
        let profile = profile(2, &[&[0], &[1]], &[(10, 0, 0), (20, 0, 1), (30, 0, 1)]);
        let filters = Filters {
            time_range_nanos: Some((15, 30)),
            ..Filters::default()
        };
        let view = top_methods(&profile, &filters);

        assert_eq!(view.total_samples, 1);
        assert_eq!(stats_of(&view, 1).self_samples, 1);
        assert_eq!(stats_of(&view, 0).total_samples, 0);
    }

    #[test]
    fn an_empty_filter_widens_instead_of_emptying_the_view() {
        let profile = profile(3, &[&[0, 1], &[0, 2]], &[(1, 0, 0), (2, 1, 1)]);
        let unfiltered = top_methods(&profile, &Filters::default());

        for filters in [
            Filters {
                threads: Some(vec![]),
                ..Filters::default()
            },
            Filters {
                time_range_nanos: Some((5, 5)),
                ..Filters::default()
            },
        ] {
            let view = top_methods(&profile, &filters);
            assert_eq!(view, unfiltered, "filters {filters:?}");
        }
    }

    #[test]
    fn an_empty_thread_selection_keeps_the_time_filter() {
        let profile = profile(2, &[&[0], &[1]], &[(10, 0, 0), (20, 1, 1)]);
        let filters = Filters {
            threads: Some(vec![]),
            time_range_nanos: Some((15, 25)),
        };
        let view = top_methods(&profile, &filters);

        assert_eq!(view.total_samples, 1);
        assert_eq!(stats_of(&view, 1).self_samples, 1);
        assert_eq!(stats_of(&view, 0).total_samples, 0);
    }
}
