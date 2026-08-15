# katan-alysis

Proto application to analyze JFRs with more views.

See [docs/PLAN.md](docs/PLAN.md) for the action plan and
[docs/JFR-viewer-bootstrap.md](docs/JFR-viewer-bootstrap.md) for the original
brief.

## Layout

```
crates/jfr-model/   shared data model (samples, frame dictionary, view models)
crates/...          ingestion (jfrs) and aggregation crates
app/src-tauri/      Tauri shell (thin IPC commands, standalone Cargo workspace)
app/ui/             SolidJS + Vite frontend, canvas rendering
```

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
