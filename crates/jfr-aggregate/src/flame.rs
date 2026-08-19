//! Flamegraph: a call tree merging stacks that share a prefix.

use jfr_model::{Filters, FlameNode, Profile};

/// Builds the flamegraph from the filtered samples: a tree rooted
/// synthetically above every stack (`frame: None`, `samples` equal to the
/// filtered sample count), with one child per distinct next frame.
///
/// A node's `samples` counts every filtered sample whose stack passes
/// through it; the gap between a node's count and the sum of its
/// children's is the samples where the frame is the leaf — drawn as the
/// node's own width with nothing stacked on top of it.
pub fn flame_graph(profile: &Profile, filters: &Filters) -> FlameNode {
    let (stack_counts, total_samples) = super::stack_counts(profile, filters);

    let mut root = FlameNode {
        frame: None,
        samples: total_samples,
        children: Vec::new(),
    };

    for (stack_id, count) in stack_counts {
        let frames = &profile.stacks[stack_id.0 as usize];
        super::merge_path(&mut root, frames, count);
    }

    super::sort_children(&mut root);
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    use jfr_model::{Frame, FrameId, Sample, StackId, ThreadId, ThreadInfo};

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

    fn child_of(node: &FlameNode, frame: u32) -> Option<&FlameNode> {
        node.children
            .iter()
            .find(|c| c.frame == Some(FrameId(frame)))
    }

    #[test]
    fn root_has_no_frame_and_counts_every_filtered_sample() {
        let profile = profile(1, &[&[0]], &[(1, 0, 0), (2, 0, 0)]);
        let tree = flame_graph(&profile, &Filters::default());

        assert_eq!(tree.frame, None);
        assert_eq!(tree.samples, 2);
    }

    #[test]
    fn stacks_sharing_a_prefix_merge_into_one_branch() {
        // 0->1->2 and 0->1->3 share the 0->1 prefix.
        let profile = profile(
            4,
            &[&[0, 1, 2], &[0, 1, 3]],
            &[(1, 0, 0), (2, 0, 0), (3, 0, 1)],
        );
        let tree = flame_graph(&profile, &Filters::default());

        let f0 = child_of(&tree, 0).unwrap();
        assert_eq!(f0.samples, 3);
        assert_eq!(f0.children.len(), 1, "0's only child is 1");
        let f1 = child_of(f0, 1).unwrap();
        assert_eq!(f1.samples, 3);
        assert_eq!(child_of(f1, 2).unwrap().samples, 2);
        assert_eq!(child_of(f1, 3).unwrap().samples, 1);
    }

    #[test]
    fn recursive_frames_form_a_chain_of_repeated_nodes() {
        // Stack 0 -> 1 -> 0: unlike top-methods, the flamegraph does not
        // dedupe recursion — each occurrence is its own node, depth-wise.
        let profile = profile(2, &[&[0, 1, 0]], &[(1, 0, 0)]);
        let tree = flame_graph(&profile, &Filters::default());

        let f0 = child_of(&tree, 0).unwrap();
        let f1 = child_of(f0, 1).unwrap();
        let f0_again = child_of(f1, 0).unwrap();
        assert_eq!(f0_again.samples, 1);
        assert!(f0_again.children.is_empty());
    }

    #[test]
    fn children_are_sorted_by_decreasing_samples_then_frame_id() {
        let profile = profile(
            3,
            &[&[0], &[1], &[2]],
            &[(1, 0, 0), (2, 0, 1), (3, 0, 1), (4, 0, 2), (5, 0, 2)],
        );
        let tree = flame_graph(&profile, &Filters::default());

        let samples: Vec<u64> = tree.children.iter().map(|c| c.samples).collect();
        assert_eq!(samples, vec![2, 2, 1]);
        // Frames 1 and 2 tie at 2 samples; the tie breaks on frame id.
        assert_eq!(tree.children[0].frame, Some(FrameId(1)));
        assert_eq!(tree.children[1].frame, Some(FrameId(2)));
    }

    #[test]
    fn thread_filter_restricts_the_tree() {
        let profile = profile(2, &[&[0], &[1]], &[(1, 0, 0), (2, 1, 1), (3, 1, 1)]);
        let filters = Filters {
            threads: Some(vec![ThreadId(1)]),
            ..Filters::default()
        };
        let tree = flame_graph(&profile, &filters);

        assert_eq!(tree.samples, 2);
        assert!(child_of(&tree, 0).is_none());
        assert_eq!(child_of(&tree, 1).unwrap().samples, 2);
    }

    #[test]
    fn time_filter_restricts_the_tree() {
        let profile = profile(2, &[&[0], &[1]], &[(10, 0, 0), (20, 0, 1), (30, 0, 1)]);
        let filters = Filters {
            time_range_nanos: Some((15, 30)),
            ..Filters::default()
        };
        let tree = flame_graph(&profile, &filters);

        assert_eq!(tree.samples, 1);
        assert_eq!(child_of(&tree, 1).unwrap().samples, 1);
        assert!(child_of(&tree, 0).is_none());
    }

    #[test]
    fn an_empty_filter_widens_instead_of_emptying_the_tree() {
        let profile = profile(3, &[&[0, 1], &[0, 2]], &[(1, 0, 0), (2, 1, 1)]);
        let unfiltered = flame_graph(&profile, &Filters::default());

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
            let tree = flame_graph(&profile, &filters);
            assert_eq!(tree, unfiltered, "filters {filters:?}");
        }
    }
}
