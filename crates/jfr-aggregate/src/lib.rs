//! Aggregations over a normalized [`Profile`].
//!
//! Every view is a pure function `(&Profile, &Filters) -> view model`.
//! Filters are applied to the sample stream before aggregation, so every
//! view benefits from them identically — there is no post-processing on
//! aggregated data.

use std::collections::HashMap;

use jfr_model::{Filters, FlameNode, FrameId, Profile, StackId};

pub mod density;
pub mod flame;
pub mod heatmap;
pub mod merged_calls;
pub mod overview;
pub mod thread_activity;
pub mod top_methods;

pub use density::sample_density;
pub use flame::flame_graph;
pub use heatmap::heatmap;
pub use merged_calls::merged_calls;
pub use overview::resample_max;
pub use thread_activity::thread_sample_counts;
pub use top_methods::top_methods;

/// Counts the filtered samples per interned stack.
///
/// Views that don't need individual timestamps (top methods, flamegraph,
/// merged callers/callees) aggregate from these counts and thus walk each
/// unique stack once, not once per sample.
fn stack_counts(profile: &Profile, filters: &Filters) -> (HashMap<StackId, u64>, u64) {
    let mut counts: HashMap<StackId, u64> = HashMap::new();
    let mut total = 0u64;
    for sample in profile.samples.iter().filter(|s| filters.accepts(s)) {
        *counts.entry(sample.stack).or_default() += 1;
        total += 1;
    }
    (counts, total)
}

/// Walks `frames` from `root`, creating a child per new frame and adding
/// `count` to every node on the path. Shared by the flamegraph (walking a
/// stack forwards from its root) and merged-calls (walking a stack's
/// prefix or suffix from the focus frame).
fn merge_path(root: &mut FlameNode, frames: &[FrameId], count: u64) {
    let mut node = root;
    for &frame in frames {
        let index = match node.children.iter().position(|c| c.frame == Some(frame)) {
            Some(index) => index,
            None => {
                node.children.push(FlameNode {
                    frame: Some(frame),
                    samples: 0,
                    children: Vec::new(),
                });
                node.children.len() - 1
            }
        };
        node = &mut node.children[index];
        node.samples += count;
    }
}

/// Orders a node's children by decreasing sample count, ties broken by
/// frame id, recursively — so a tree built by [`merge_path`] is
/// deterministic across runs over the same selection.
fn sort_children(node: &mut FlameNode) {
    node.children
        .sort_by(|a, b| b.samples.cmp(&a.samples).then(a.frame.cmp(&b.frame)));
    for child in &mut node.children {
        sort_children(child);
    }
}
