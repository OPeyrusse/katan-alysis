# katan-alysis

Proto application to analyze JFRs with more views.

See [docs/PLAN.md](docs/PLAN.md) for the action plan,
[docs/JFR-viewer-bootstrap.md](docs/JFR-viewer-bootstrap.md) for the original
brief, and [specs/katan-alysis.allium](specs/katan-alysis.allium) for the
behavioural specification.

## Layout

```
crates/jfr-model/   shared data model (samples, frame dictionary, view models)
crates/...          ingestion (jfrs) and aggregation crates
app/src-tauri/      Tauri shell (thin IPC commands, standalone Cargo workspace)
app/ui/             SolidJS + Vite frontend, canvas rendering
specs/              Allium behavioural specification
```

## Specification

`specs/katan-alysis.allium` describes what the application does — entities,
rules and boundary contracts — without prescribing how it is built. It is
maintained alongside the code: any change to observable behaviour updates the
spec in the same commit.

The [Allium](https://juxt.github.io/allium) checker validates it:

```
cargo install allium-cli
allium check specs/      # structural diagnostics
allium analyse specs/    # + data flow, reachability, conflicts
```

Agents working in this repo get the Allium skills from `.claude/skills`
(`/allium`, `/elicit`, `/distill`, `/propagate`, `/tend`, `/weed`) and a
`PostToolUse` hook that runs `allium check` on every `.allium` edit.

## Development

Rust data crates (no system dependencies):

```
cargo test --workspace
```

Coverage (same gate as CI — fails under 80% line coverage; needs
`rustup component add llvm-tools-preview` and [cargo-llvm-cov]):

```
cargo llvm-cov --workspace --fail-under-lines 80   # per-module summary + gate
cargo llvm-cov report --html                       # browsable report in target/llvm-cov/html
```

[cargo-llvm-cov]: https://github.com/taiki-e/cargo-llvm-cov

Tauri shell (needs `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` on Linux):

```
cargo test --manifest-path app/src-tauri/Cargo.toml
```

Frontend (pnpm workspace):

```
pnpm install
pnpm -C app/ui test        # vitest
pnpm -C app/ui typecheck
pnpm -C app/ui lint
pnpm -C app/ui build
```

Run the desktop app in dev mode: `pnpm tauri dev` (from the repo root).

Release build (Linux binary + .deb package):

```
pnpm tauri build
# -> app/src-tauri/target/release/katan-alysis
# -> app/src-tauri/target/release/bundle/deb/*.deb
```

CI builds both on every commit to `main` (job `tauri-build`) and publishes
them as build artifacts under `app/`.
