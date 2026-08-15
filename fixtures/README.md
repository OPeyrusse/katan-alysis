# Test fixtures

## fixture.jfr

JDK-produced flight recording of `FixtureWorkload.java`, used by the
`jfr-ingest` non-regression tests. Two threads (`main` and `fixture-worker`)
funnel into the same `hotCoordinator` method through different call paths —
the "diluted bottleneck" scenario the merged callers/callees view targets.

Regenerate with:

```
javac FixtureWorkload.java
java -XX:StartFlightRecording=filename=fixture.jfr,settings=$PWD/minimal-profile.jfc,duration=10s \
    FixtureWorkload 3000
```

**Always record with `minimal-profile.jfc`, never with the built-in
`profile`/`default` settings**: those capture the recording machine's
environment variables, system properties, and process list into the file —
including any secrets they contain. The minimal settings enable
`jdk.ExecutionSample` only. After regenerating, sanity-check with
`jfr summary fixture.jfr` (only ExecutionSample/Checkpoint/Metadata should
have a non-zero count) and update the sample count asserted in
`crates/jfr-ingest/tests/fixture.rs` (currently 570).

## fixture-metadata.jfr

JDK-produced recording of `MetadataWorkload.java` (CPU burn + allocation
churn), used by the metadata/overview ingestion tests: execution samples
plus the overview signals (`jdk.CPULoad`, `jdk.GCHeapSummary`,
`jdk.ResidentSetSize`, `jdk.GarbageCollection`) and the one-shot metadata
events (`jdk.JVMInformation`, `jdk.GCConfiguration`,
`jdk.GCHeapConfiguration`, `jdk.OSInformation`, `jdk.CPUInformation`,
`jdk.PhysicalMemory`, `jdk.UnsignedLongFlag`, `jdk.BooleanFlag`).

Regenerate with (note `env -u JAVA_TOOL_OPTIONS`: anything in that
variable ends up verbatim in the recording's `jvmArguments`):

```
javac MetadataWorkload.java
env -u JAVA_TOOL_OPTIONS java -Xmx256m -Xms128m -XX:MaxDirectMemorySize=64m \
    -XX:+UnlockDiagnosticVMOptions -XX:+DebugNonSafepoints \
    -XX:StartFlightRecording=filename=fixture-metadata.jfr,settings=$PWD/metadata-profile.jfc,duration=6s \
    MetadataWorkload 4000
```

**Always record with `metadata-profile.jfc`**: like `minimal-profile.jfc`
it excludes environment variables, system properties and process lists —
flag events only carry names, values and origins. After regenerating,
check `jfr summary` and update the counts asserted in
`crates/jfr-ingest/tests/fixture_metadata.rs` (samples, CPULoad, RSS) and
`jfr print --events jdk.JVMInformation` to confirm `jvmArguments` holds
only the flags above.

## Still missing

An async-profiler recording of a real workload, to validate the `jfrs`
parser against non-JDK JFR files (see the spike checklist in
`docs/JFR-viewer-bootstrap.md`). Add one here as `fixture-async-profiler.jfr`
when available.
