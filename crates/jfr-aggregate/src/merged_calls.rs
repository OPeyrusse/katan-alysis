//! Merged callers/callees: what leads into and out of one focus method.

use jfr_model::{Filters, FlameNode, FrameId, MergedCallTree, Profile};

/// Builds the merged-calls view for `focus` from the filtered samples.
///
/// Every filtered stack that contains `focus` is split at its first
/// occurrence — the same rule [`jfr_model::MethodStats::total_samples`]
/// uses for recursion, once per stack rather than once per depth. The
/// prefix before that occurrence, reversed (immediate caller first), feeds
/// the callers tree; the suffix from that occurrence on feeds the callees
/// tree. Both are merged the way the flamegraph merges stacks, and are
/// therefore rooted at `focus` with the same `samples`.
pub fn merged_calls(profile: &Profile, filters: &Filters, focus: FrameId) -> MergedCallTree {
    let (stack_counts, _) = super::stack_counts(profile, filters);

    let mut callers = FlameNode {
        frame: Some(focus),
        samples: 0,
        children: Vec::new(),
    };
    let mut callees = FlameNode {
        frame: Some(focus),
        samples: 0,
        children: Vec::new(),
    };

    for (stack_id, count) in stack_counts {
        let frames = &profile.stacks[stack_id.0 as usize];
        let Some(index) = frames.iter().position(|&f| f == focus) else {
            continue;
        };

        callers.samples += count;
        callees.samples += count;

        let callers_path: Vec<FrameId> = frames[..index].iter().rev().copied().collect();
        super::merge_path(&mut callers, &callers_path, count);
        super::merge_path(&mut callees, &frames[index + 1..], count);
    }

    super::sort_children(&mut callers);
    super::sort_children(&mut callees);

    MergedCallTree {
        focus,
        callers,
        callees,
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

    fn child_of(node: &FlameNode, frame: u32) -> Option<&FlameNode> {
        node.children
            .iter()
            .find(|c| c.frame == Some(FrameId(frame)))
    }

    #[test]
    fn both_trees_are_rooted_at_the_focus_with_its_total_samples() {
        // 0 -> 1 -> 2, focus on 1.
        let profile = profile(3, &[&[0, 1, 2]], &[(1, 0, 0), (2, 0, 0)]);
        let tree = merged_calls(&profile, &Filters::default(), FrameId(1));

        assert_eq!(tree.focus, FrameId(1));
        assert_eq!(tree.callers.frame, Some(FrameId(1)));
        assert_eq!(tree.callers.samples, 2);
        assert_eq!(tree.callees.frame, Some(FrameId(1)));
        assert_eq!(tree.callees.samples, 2);
    }

    #[test]
    fn callees_tree_merges_the_paths_after_the_focus() {
        // 0 -> 1 -> 2 and 0 -> 1 -> 3 share the immediate caller 0->1, but
        // diverge below the focus (1).
        let profile = profile(
            4,
            &[&[0, 1, 2], &[0, 1, 3]],
            &[(1, 0, 0), (2, 0, 0), (3, 0, 1)],
        );
        let tree = merged_calls(&profile, &Filters::default(), FrameId(1));

        assert_eq!(child_of(&tree.callees, 2).unwrap().samples, 2);
        assert_eq!(child_of(&tree.callees, 3).unwrap().samples, 1);
        assert!(child_of(&tree.callees, 0).is_none());
    }

    #[test]
    fn callers_tree_merges_the_reversed_paths_before_the_focus() {
        // pathA and pathB both call hotCoordinator (2); the immediate
        // caller differs, so it becomes the caller tree's first level.
        let profile = profile(3, &[&[0, 2], &[1, 2]], &[(1, 0, 0), (2, 0, 0), (3, 0, 1)]);
        let tree = merged_calls(&profile, &Filters::default(), FrameId(2));

        assert_eq!(child_of(&tree.callers, 0).unwrap().samples, 2);
        assert_eq!(child_of(&tree.callers, 1).unwrap().samples, 1);
    }

    #[test]
    fn focus_as_stack_leaf_has_no_callees() {
        let profile = profile(2, &[&[0, 1]], &[(1, 0, 0)]);
        let tree = merged_calls(&profile, &Filters::default(), FrameId(1));

        assert_eq!(tree.callees.samples, 1);
        assert!(tree.callees.children.is_empty());
        assert_eq!(child_of(&tree.callers, 0).unwrap().samples, 1);
    }

    #[test]
    fn focus_as_stack_root_has_no_callers() {
        let profile = profile(2, &[&[0, 1]], &[(1, 0, 0)]);
        let tree = merged_calls(&profile, &Filters::default(), FrameId(0));

        assert_eq!(tree.callers.samples, 1);
        assert!(tree.callers.children.is_empty());
        assert_eq!(child_of(&tree.callees, 1).unwrap().samples, 1);
    }

    #[test]
    fn recursive_focus_splits_at_its_first_occurrence() {
        // Stack 1 -> 0 -> 1 -> 2: the focus (1) recurs. The first
        // occurrence's caller is 1's own outer call (frame 0); its
        // callees walk everything from that first occurrence on,
        // recursion included.
        let profile = profile(3, &[&[1, 0, 1, 2]], &[(1, 0, 0)]);
        let tree = merged_calls(&profile, &Filters::default(), FrameId(1));

        assert_eq!(tree.callers.samples, 1);
        assert_eq!(tree.callees.samples, 1);
        assert!(tree.callers.children.is_empty(), "1 is already the root");
        let inner_zero = child_of(&tree.callees, 0).unwrap();
        assert_eq!(inner_zero.samples, 1);
        let inner_one = child_of(inner_zero, 1).unwrap();
        assert_eq!(inner_one.samples, 1);
        assert_eq!(child_of(inner_one, 2).unwrap().samples, 1);
    }

    #[test]
    fn frame_absent_from_a_stack_contributes_nothing() {
        let profile = profile(3, &[&[0, 1], &[2]], &[(1, 0, 0), (2, 0, 1)]);
        let tree = merged_calls(&profile, &Filters::default(), FrameId(1));

        assert_eq!(tree.callers.samples, 1);
        assert_eq!(tree.callees.samples, 1);
    }

    #[test]
    fn thread_filter_restricts_the_trees() {
        let profile = profile(2, &[&[0, 1]], &[(1, 0, 0), (2, 1, 0)]);
        let filters = Filters {
            threads: Some(vec![ThreadId(1)]),
            ..Filters::default()
        };
        let tree = merged_calls(&profile, &filters, FrameId(1));

        assert_eq!(tree.callers.samples, 1);
        assert_eq!(tree.callees.samples, 1);
    }

    #[test]
    fn time_filter_restricts_the_trees() {
        let profile = profile(2, &[&[0, 1]], &[(10, 0, 0), (20, 0, 0)]);
        let filters = Filters {
            time_range_nanos: Some((15, 30)),
            ..Filters::default()
        };
        let tree = merged_calls(&profile, &filters, FrameId(1));

        assert_eq!(tree.callers.samples, 1);
        assert_eq!(tree.callees.samples, 1);
    }

    #[test]
    fn an_empty_filter_widens_instead_of_emptying_the_trees() {
        let profile = profile(3, &[&[0, 1], &[0, 2]], &[(1, 0, 0), (2, 1, 1)]);
        let unfiltered = merged_calls(&profile, &Filters::default(), FrameId(0));

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
            let tree = merged_calls(&profile, &filters, FrameId(0));
            assert_eq!(tree, unfiltered, "filters {filters:?}");
        }
    }
}
