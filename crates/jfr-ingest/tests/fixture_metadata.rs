//! Non-regression tests against the metadata fixture: a JDK-produced
//! recording of `fixtures/MetadataWorkload.java` carrying the overview
//! signals (CPU load, heap summaries, RSS, GC) and the JVM/GC/OS metadata
//! (see `fixtures/README.md`). Recorded with:
//! `-Xmx256m -Xms128m -XX:MaxDirectMemorySize=64m
//!  -XX:+UnlockDiagnosticVMOptions -XX:+DebugNonSafepoints`.

use std::fs::File;

use jfr_model::Profile;

fn fixture() -> Profile {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/fixture-metadata.jfr"
    );
    jfr_ingest::read_profile(File::open(path).unwrap()).unwrap()
}

fn minimal_fixture() -> Profile {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/fixture.jfr");
    jfr_ingest::read_profile(File::open(path).unwrap()).unwrap()
}

#[test]
fn samples_still_read_alongside_the_metadata() {
    // `jfr summary` reports 357 jdk.ExecutionSample events in the fixture.
    assert_eq!(fixture().samples.len(), 357);
}

#[test]
fn reads_the_jvm_identity() {
    let info = fixture().info;
    assert_eq!(info.jvm_name.as_deref(), Some("OpenJDK 64-Bit Server VM"));
    assert!(info.jvm_version.unwrap().contains("21.0"));
}

#[test]
fn reads_the_gc_configuration() {
    let info = fixture().info;
    assert_eq!(info.young_collector.as_deref(), Some("G1New"));
    assert_eq!(info.old_collector.as_deref(), Some("G1Old"));
    assert_eq!(info.heap_max_bytes, Some(256 * 1024 * 1024));
}

#[test]
fn reads_the_host_description() {
    let info = fixture().info;
    assert!(info.os_version.unwrap().contains("Linux"));
    assert!(info.cpu_cores.unwrap() > 0);
    assert!(info.hw_threads.unwrap() > 0);
    assert!(info.physical_memory_bytes.unwrap() > 1024 * 1024 * 1024);
}

#[test]
fn reads_the_key_flags_with_their_origin() {
    let info = fixture().info;
    let xmx = info.xmx.unwrap();
    assert_eq!(xmx.value, 256 * 1024 * 1024);
    assert_eq!(xmx.origin, "Command line");
    let xms = info.xms.unwrap();
    assert_eq!(xms.value, 128 * 1024 * 1024);
    assert_eq!(xms.origin, "Command line");
    let direct = info.max_direct_memory.unwrap();
    assert_eq!(direct.value, 64 * 1024 * 1024);
    assert_eq!(direct.origin, "Command line");
    let dns = info.debug_non_safepoints.unwrap();
    assert!(dns.value);
    assert_eq!(dns.origin, "Command line");
}

#[test]
fn reads_the_cpu_load_signal() {
    let signals = fixture().signals;
    // `jfr summary` reports 40 jdk.CPULoad events.
    assert_eq!(signals.cpu_jvm_user.len(), 40);
    assert_eq!(signals.cpu_jvm_system.len(), 40);
    assert_eq!(signals.cpu_machine_total.len(), 40);
    assert!(signals.cpu_jvm_user.is_sorted_by_key(|p| p.ts_nanos));
    // A CPU-bound workload must show real load, and loads are fractions.
    assert!(signals.cpu_jvm_user.iter().any(|p| p.value > 0.05));
    assert!(
        signals
            .cpu_machine_total
            .iter()
            .all(|p| (0.0..=1.0).contains(&p.value))
    );
}

#[test]
fn reads_the_heap_signal() {
    let signals = fixture().signals;
    assert!(!signals.heap_used_bytes.is_empty());
    assert_eq!(
        signals.heap_used_bytes.len(),
        signals.heap_committed_bytes.len()
    );
    assert!(signals.heap_used_bytes.is_sorted_by_key(|p| p.ts_nanos));
    // The heap moves under allocation churn, and stays under -Xmx.
    let max = signals
        .heap_used_bytes
        .iter()
        .map(|p| p.value)
        .fold(0.0, f64::max);
    assert!(max > 10.0 * 1024.0 * 1024.0);
    assert!(max <= 256.0 * 1024.0 * 1024.0);
}

#[test]
fn reads_the_rss_signal() {
    let signals = fixture().signals;
    // `jfr summary` reports 40 jdk.ResidentSetSize events.
    assert_eq!(signals.rss_bytes.len(), 40);
    // RSS covers heap + off-heap + native: bigger than the heap floor.
    assert!(signals.rss_bytes.iter().all(|p| p.value > 1024.0 * 1024.0));
}

#[test]
fn reads_the_gc_pauses() {
    let signals = fixture().signals;
    assert!(!signals.gc_pauses.is_empty());
    assert!(signals.gc_pauses.is_sorted_by_key(|p| p.ts_nanos));
    for pause in &signals.gc_pauses {
        assert!(pause.duration_nanos > 0, "pause without a duration");
        assert!(!pause.name.is_empty());
        assert!(!pause.cause.is_empty());
    }
}

#[test]
fn signal_timestamps_share_the_sample_clock() {
    let profile = fixture();
    let (start, end) = profile.time_range_nanos().unwrap();
    let margin = 2_000_000_000; // signals may lead/trail the sampling a bit
    for point in profile
        .signals
        .cpu_jvm_user
        .iter()
        .chain(&profile.signals.rss_bytes)
    {
        assert!(point.ts_nanos > start - margin && point.ts_nanos < end + margin);
    }
}

#[test]
fn a_minimal_recording_has_no_metadata_and_no_signals() {
    let profile = minimal_fixture();
    assert_eq!(profile.info, jfr_model::RecordingInfo::default());
    assert_eq!(profile.signals, jfr_model::Signals::default());
}
