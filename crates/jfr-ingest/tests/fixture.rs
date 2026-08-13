//! Non-regression tests against a real JFR recording.
//!
//! The fixture is a JDK-produced recording of `fixtures/FixtureWorkload.java`
//! (see `fixtures/README.md`): two threads, both funneling into
//! `hotCoordinator` through different call paths.

use std::fs::File;

use jfr_model::Profile;

fn fixture() -> Profile {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/fixture.jfr");
    jfr_ingest::read_profile(File::open(path).unwrap()).unwrap()
}

fn frame_labels(profile: &Profile) -> Vec<String> {
    profile.frames.iter().map(|f| f.label()).collect()
}

#[test]
fn reads_every_execution_sample() {
    // `jfr summary` reports 570 jdk.ExecutionSample events in the fixture.
    assert_eq!(fixture().samples.len(), 570);
}

#[test]
fn indices_are_dense_and_valid() {
    let profile = fixture();
    for sample in &profile.samples {
        assert!((sample.stack.0 as usize) < profile.stacks.len());
        assert!((sample.thread.0 as usize) < profile.threads.len());
    }
    for stack in &profile.stacks {
        assert!(!stack.is_empty());
        for frame in stack {
            assert!((frame.0 as usize) < profile.frames.len());
        }
    }
}

#[test]
fn timestamps_are_per_sample_and_plausible() {
    let profile = fixture();
    let (start, end) = profile.time_range_nanos().unwrap();
    let span_millis = (end - start) / 1_000_000;
    // The workload runs for ~3 s, sampled at ~20 ms intervals.
    assert!(
        (1_000..10_000).contains(&span_millis),
        "unexpected recording span: {span_millis} ms"
    );
    assert!(profile.samples.is_sorted_by_key(|s| s.ts_nanos));
    // Timestamps must differ between samples (no aggregation happened).
    let distinct: std::collections::HashSet<i64> =
        profile.samples.iter().map(|s| s.ts_nanos).collect();
    assert!(distinct.len() > profile.samples.len() / 2);
}

#[test]
fn resolves_both_workload_threads() {
    let profile = fixture();
    let names: Vec<&str> = profile.threads.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"main"), "threads: {names:?}");
    assert!(names.contains(&"fixture-worker"), "threads: {names:?}");
}

#[test]
fn resolves_workload_frames_with_dotted_class_names() {
    let profile = fixture();
    let labels = frame_labels(&profile);
    for expected in [
        "FixtureWorkload.hotCoordinator",
        "FixtureWorkload.pathA",
        "FixtureWorkload.pathB",
        "FixtureWorkload.expensiveLeaf",
        "java.util.Random.nextInt",
    ] {
        assert!(
            labels.iter().any(|l| l == expected),
            "missing frame {expected}"
        );
    }
}

#[test]
fn stacks_are_root_first() {
    let profile = fixture();
    let labels = frame_labels(&profile);
    let mut saw_main_rooted_stack = false;
    for stack in &profile.stacks {
        let root = &labels[stack[0].0 as usize];
        if root == "FixtureWorkload.main" {
            saw_main_rooted_stack = true;
        }
        // A JVM entry point must never sit at the leaf end of a stack.
        let leaf = &labels[stack.last().unwrap().0 as usize];
        assert_ne!(leaf, "FixtureWorkload.main");
    }
    assert!(saw_main_rooted_stack);
}

#[test]
fn samples_share_interned_stacks() {
    let profile = fixture();
    // 504 samples over a workload with a handful of call paths must share
    // stacks; a dictionary as large as the sample list means broken interning.
    assert!(profile.stacks.len() < profile.samples.len() / 2);
}
