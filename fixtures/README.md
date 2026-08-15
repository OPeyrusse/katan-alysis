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

## Still missing

An async-profiler recording of a real workload, to validate the `jfrs`
parser against non-JDK JFR files (see the spike checklist in
`docs/JFR-viewer-bootstrap.md`). Add one here as `fixture-async-profiler.jfr`
when available.
