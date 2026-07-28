# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

boxsh (npm: `@boxsh/sandbox`) runs shell commands against an isolated virtual filesystem from JavaScript — Node ≥20 or the browser. No host shell, no host filesystem. The shell interpreter lives in TypeScript; the commands themselves are Rust compiled to `wasm32-wasip1`. The directory is still named `nobox` (pre-rename); the project is boxsh everywhere else.

## Commands

Rust checks (root workspace):

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test --workspace --target wasm32-wasip1   # needs wasmtime on PATH
```

JS package (`packages/boxsh`) — the tests run against real wasm artifacts, so build these first:

```sh
cargo build --release --target wasm32-wasip1 -p boxsh-abi --features host-commands   # fs + shell module
cargo build --release --target wasm32-wasip1 --manifest-path examples/playground/coreutils-demo/Cargo.toml
cargo build --release --target wasm32-wasip1 --manifest-path examples/playground/hot-demo/Cargo.toml
```

(`host-commands` declares the shell's `boxsh_host` command imports — shipped artifacts need it; test builds leave it off so plain WASI runners can instantiate the module.)

then:

```sh
npm run build --prefix packages/boxsh    # tsc → dist/
npm test --prefix packages/boxsh         # runs test/smoke.mjs + test/api.mjs
```

Single test: `node packages/boxsh/test/api.mjs` (tests are plain Node scripts with `assert`, no framework).

`npm run build:engine --prefix packages/boxsh` builds both demo crates and copies them into `packages/boxsh/engine/` (runs `wasm-opt` if installed — `brew install binaryen`; warns and ships unoptimized otherwise). Required before `npm run test:bundled` (zero-arg `loadEngine()` packaging test) and before `npm pack`/publish — `prepack` runs a check that refuses to pack without valid engine modules.

## Architecture

Two layers connected by a minimal wasm ABI:

**TypeScript layer** (`packages/boxsh/src/`) — the public API and host glue; the filesystem AND the shell live in Rust (crates/boxsh-fs, crates/boxsh-shell, exported via boxsh-abi into `engine/fs.wasm`):
- `filesystem.ts` + `backend.ts` + `backends/` — `Filesystem` over a `StorageBackend` interface; live migration between backends is supported. Built-ins: `memory()` (TS map, Filesystem-only — Sandbox refuses it), `wasmMemory()` (Rust fs, non-persistent), `indexeddb()` and `opfs()` (persistent: they replicate the Rust fs journal via `backends/replicated.ts` — contract in crates/boxsh-fs/DESIGN.md).
- `engine.ts` — executes individual commands against the storage backend by instantiating wasm modules with WASI shims mapped onto the virtual filesystem. Also serves as the shell's `CommandHost`.
- `loader.ts` — low-level wasm loading; enforces `SUPPORTED_ABI_VERSION`, the `boxsh_alloc`/`boxsh_free` exchange, and the `boxsh_host` command-import trampolines (`setHost`).
- `sandbox.ts` — `Sandbox.exec()` delegates to the in-module Rust shell (`boxsh_shell_exec`), ferrying the session (env/cwd/last status) per call. Non-zero exits are returned, not thrown. Requires a wasm-backed filesystem.

**Command execution** — two tiers:
- *In-module* (`crates/boxsh-commands`, compiled into `engine/fs.wasm`): the ten hot-path commands (true/false/echo/cat/tee/wc/seq/head/sort/grep) run inside the sandbox module directly on the `Backend` trait — no WASI, no boundary. The shell routes here first.
- *Cold* (`examples/playground/coreutils-demo`, shipped as `engine/commands.wasm`): a multicall binary bundling ~70 uutils coreutils as a wasip1 *command* module — a fresh instance per command, WASI shims in engine.ts, reached via the `boxsh_host` import when the shell doesn't know a command. (The old hot-demo reactor is retired from the package; the playground/bench still use it.)

The demo crates, `bench/rust`, and `crates/boxsh-store-sqlite` (native-only SQLite persistence over the boxsh-fs replication contract; rusqlite dep) are standalone Cargo packages (own `[workspace]` stanzas) deliberately kept out of the root workspace. The root workspace crates: `boxsh-core` (block-storage primitives, currently dormant — **zero dependencies, enforced**; see its Cargo.toml), `boxsh-fs` (the virtual filesystem: `Backend` trait, `MemoryBackend` with dirty-path journal for host replication, tar codec — zero dependencies; see its DESIGN.md), `boxsh-shell` (the shell language over `Backend` + a `CommandRunner` trait — zero deps beyond boxsh-fs; ported from the retired shell.ts with documented bug-fix divergences), `boxsh-commands` (the in-module command tier; regex-lite is its one external dep), `boxsh-utils` (command support), `boxsh-abi` (cdylib exporting the versioned ABI: alloc/free exchange + `boxsh_fs_*` filesystem exports + `boxsh_shell_exec`).

Direction (2026-07): the whole sandbox is moving into Rust — filesystem (done: `boxsh-fs`), then shell + coreutils as a single wasm reactor with the TS package reduced to a loader/async facade/persistence adapters. Backends may be native-only and feature-gated out of the wasm build; `boxsh-fs` itself must always build on `wasm32-wasip1`.

Benchmarks live in `bench/` — one harness per runtime (browser, node, bun, native rust); see bench/README.md for what each measures and how to run it.

## Constraints to respect

- The `wasm-opt` levels in `scripts/build-engine.mjs` (`-Oz` cold, `-O3` hot) were chosen by measurement; the comments record regressions from "upgrading" them. Don't change without re-benchmarking.
- CI (`.github/workflows/ci.yml`) enforces a 3 MiB gzip size budget on the `boxsh-abi` artifact and runs the workspace unit tests on `wasm32-wasip1` as well as native.
- Binary data stays bytes across public APIs (`stdoutBytes` alongside `stdout`, etc.).
- User-facing docs live in `docs/` at the repo root; `prepack` copies them into the package tarball (`scripts/sync-docs.mjs`) — edit them at the root, not in `packages/boxsh/docs/`.
- From CONTRIBUTING: keep implementation rationale in code comments/tests/contributor docs rather than user-facing errors and output; keep errors actionable without exposing internal state.
