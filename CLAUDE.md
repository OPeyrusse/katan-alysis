# katan-alysis

Desktop application that reads JFR recordings and shows profiling views the
JDK tooling does not: flat profile, flamegraph, FlameScope-style heatmap and
merged callers/callees. Rust for everything data, SolidJS in a Tauri shell for
everything visible.

## Layout

```
crates/jfr-model/       shared data contract (samples, frame dictionary, view models)
crates/jfr-ingest/      jfrs-backed ingestion into the normalized profile
crates/jfr-aggregate/   pure aggregations: (&Profile, &Filters) -> view model
app/src-tauri/          Tauri shell: thin IPC commands, own Cargo workspace
app/ui/                 SolidJS + Vite frontend
specs/                  Allium behavioural specification
docs/PLAN.md            action plan and milestones
```

## Commands

```
cargo test --workspace                              # Rust data crates
cargo llvm-cov --workspace --fail-under-lines 80    # same coverage gate as CI
cargo test --manifest-path app/src-tauri/Cargo.toml # Tauri shell (needs webkit2gtk/gtk)
pnpm -C app/ui test                                 # vitest
pnpm -C app/ui typecheck
pnpm -C app/ui lint
pnpm tauri dev                                      # run the desktop app
./scripts/check-specs.sh                            # validate the spec (same gate as CI)
```

## Architecture rules

- The `Profile` in `jfr-model` is the contract. Frames are shared by index,
  never by string; view models are already aggregated so IPC payloads stay small.
- Filters (`threads`, `time_range_nanos`) are applied to the sample stream
  **before** aggregation. Views never post-process aggregated data, and the UI
  never filters client-side — a filter change re-queries the backend.
- An empty filter is not a filter: an empty thread list, or a time range
  holding no instant, widens back to the whole recording rather than emptying
  the views. Each category is independent of the other.
- `app/src-tauri` holds no logic. Every command is a thin wrapper over a plain
  function taking `&RecordingState`, so it is unit-testable without a webview.
- Timestamps cross the IPC boundary relative to the start of the recording;
  absolute epoch nanoseconds overflow JavaScript's safe integer range.
- UI geometry (canvas layout, hit-testing) lives in pure functions under
  `render/`, tested without a browser.

## The specification comes first

`specs/katan-alysis.allium` is an [Allium](https://juxt.github.io/allium)
behavioural specification: what the application does, in domain terms, with no
implementation detail. It is the primary artefact — the code implements it.

**Follow it, and keep it current:**

- Read the spec before implementing or changing behaviour. It is the reference
  for what the system is supposed to do; the code only shows what it happens to
  do today.
- Any change to observable behaviour — a new view, a new filter, a different
  outcome when opening a recording, a changed rule about how samples are
  counted — updates `specs/katan-alysis.allium` **in the same change** as the
  code. A spec that lags behind the code is worse than no spec.
- Refactors, performance work and anything invisible to the analyst leave the
  spec untouched. If a change does not alter observable behaviour, it does not
  belong in the spec.
- Run `./scripts/check-specs.sh` after editing. It runs `allium analyse` and
  fails on errors and on process-level findings; the remaining warnings
  (external entities without a governing spec) and info diagnostics are
  expected. CI runs the same script in the `spec-check` job, so a spec that
  does not check does not merge.
- Open design questions go in the `open question` section of the spec rather
  than in a comment in the code.

The Allium skills are installed in `.claude/skills` and drive the loop:
`/allium` (whole loop), `/elicit` (spec from intent), `/distill` (spec from
existing code), `/propagate` (tests from the spec), `/tend` (targeted spec
edit), `/weed` (find and fix spec-vs-code drift). `/weed` is the one to reach
for when the spec and the code may have drifted apart.

The CLI comes from `cargo install allium-cli`. A `PostToolUse` hook
(`.claude/hooks/allium-check.sh`, wired in `.claude/settings.json`) validates
any `.allium` file right after it is written; without the CLI installed the
hook is a no-op.

## Conventions

- Rust: `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings`,
  both gated in CI, plus 80% line coverage.
- Every crate is testable in isolation: `jfr-aggregate` against synthetic
  profiles, `jfr-ingest` against the real fixtures in `fixtures/`, the UI
  against a mocked `@tauri-apps/api`.
- Comments explain why, not what. Match the density of the surrounding code.
