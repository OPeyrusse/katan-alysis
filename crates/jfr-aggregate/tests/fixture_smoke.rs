//! End-to-end sanity check: ingest the real fixture and aggregate it.
//!
//! The fixture workload funnels three call paths (`pathA`, `pathB`, and the
//! worker thread's loop) into `hotCoordinator` — the "diluted bottleneck"
//! scenario. Its aggregate `total` must therefore dominate its `self` count,
//! which is exactly what the flat profile is meant to surface.

use std::fs::File;

use jfr_model::{Filters, FrameId, MethodStats};

fn frame_id_of(profile: &jfr_model::Profile, label: &str) -> FrameId {
    let index = profile
        .frames
        .iter()
        .position(|f| f.label() == label)
        .unwrap_or_else(|| panic!("no frame for {label}"));
    FrameId(index as u32)
}

#[test]
fn fixture_flat_profile_surfaces_the_hot_coordinator() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/fixture.jfr");
    let profile = jfr_ingest::read_profile(File::open(path).unwrap()).unwrap();
    let view = jfr_aggregate::top_methods(&profile, &Filters::default());

    assert_eq!(view.total_samples, profile.samples.len() as u64);

    let stats_by_label = |label: &str| -> MethodStats {
        let (frame_id, stats) = view
            .rows
            .iter()
            .find(|(id, _)| profile.frames[id.0 as usize].label() == label)
            .unwrap_or_else(|| panic!("no row for {label}"));
        assert!((frame_id.0 as usize) < profile.frames.len());
        *stats
    };

    let coordinator = stats_by_label("FixtureWorkload.hotCoordinator");
    // Nearly all CPU time flows through the coordinator...
    assert!(coordinator.total_samples > view.total_samples / 2);
    // ...but it is not itself the leaf: the cost shows in total, not self.
    assert!(coordinator.self_samples < coordinator.total_samples / 4);

    // The actual leaf work happens below it.
    let leaf = stats_by_label("FixtureWorkload.expensiveLeaf");
    assert!(leaf.total_samples > view.total_samples / 2);
}

#[test]
fn fixture_merged_calls_splits_the_diluted_bottleneck() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/fixture.jfr");
    let profile = jfr_ingest::read_profile(File::open(path).unwrap()).unwrap();
    let coordinator = frame_id_of(&profile, "FixtureWorkload.hotCoordinator");
    let tree = jfr_aggregate::merged_calls(&profile, &Filters::default(), coordinator);

    assert_eq!(tree.focus, coordinator);
    assert_eq!(tree.callers.samples, tree.callees.samples);

    // pathA, pathB and the worker's loop all call hotCoordinator directly:
    // three distinct immediate callers merge into three branches.
    assert_eq!(tree.callers.children.len(), 3);

    // Below it, the actual leaf work dominates the cheap one.
    let expensive_leaf = frame_id_of(&profile, "FixtureWorkload.expensiveLeaf");
    let cheap_work = frame_id_of(&profile, "FixtureWorkload.cheapWork");
    let leaf_samples = tree
        .callees
        .children
        .iter()
        .find(|c| c.frame == Some(expensive_leaf))
        .unwrap()
        .samples;
    let cheap_samples = tree
        .callees
        .children
        .iter()
        .find(|c| c.frame == Some(cheap_work))
        .unwrap()
        .samples;
    assert!(leaf_samples > cheap_samples);
}
