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
cargo build --release --target wasm32-wasip1 -p boxsh-abi   # for test/smoke.mjs
cargo build --release --target wasm32-wasip1 --manifest-path examples/playground/coreutils-demo/Cargo.toml
cargo build --release --target wasm32-wasip1 --manifest-path examples/playground/hot-demo/Cargo.toml
```

then:

```sh
npm run build --prefix packages/boxsh    # tsc → dist/
npm test --prefix packages/boxsh         # runs test/smoke.mjs + test/api.mjs
```

Single test: `node packages/boxsh/test/api.mjs` (tests are plain Node scripts with `assert`, no framework).

`npm run build:engine --prefix packages/boxsh` builds both demo crates and copies them into `packages/boxsh/engine/` (runs `wasm-opt` if installed — `brew install binaryen`; warns and ships unoptimized otherwise). Required before `npm run test:bundled` (zero-arg `loadEngine()` packaging test) and before `npm pack`/publish — `prepack` runs a check that refuses to pack without valid engine modules.

## Architecture

Two layers connected by a minimal wasm ABI:

**TypeScript layer** (`packages/boxsh/src/`) — the entire public API and the shell itself:
- `filesystem.ts` + `backend.ts` + `backends/memory.ts` — `Filesystem` over a `StorageBackend` interface (memory backend is the only built-in; live migration between backends is supported).
- `shell.ts` — the shell language implementation: tokenizing, pipes, redirects, conditionals, variables, command substitution, heredocs, loops. This is TS code, not wasm.
- `engine.ts` — executes individual commands against the storage backend by instantiating wasm modules with WASI shims mapped onto the virtual filesystem.
- `loader.ts` — low-level wasm loading; enforces `SUPPORTED_ABI_VERSION` and the `boxsh_alloc`/`boxsh_free` exchange contract.
- `sandbox.ts` — ties `Filesystem` + engine + shell session (persistent env/cwd) into `Sandbox.exec()`. Non-zero exits are returned, not thrown.

**Wasm command modules** — two execution models, both shipped in `packages/boxsh/engine/`:
- *Cold* (`examples/playground/coreutils-demo`): a multicall binary bundling ~70 uutils coreutils as a wasip1 *command* module — a fresh instance per command.
- *Hot* (`examples/playground/hot-demo`): a wasip1 *reactor* — initialized once, commands are function calls. Only commands in `HOT_COMMANDS` (engine.ts) route here; it's 32–50% faster on hot paths.

The demo crates are standalone Cargo packages (own `[workspace]` stanzas) deliberately kept out of the root workspace. The root workspace crates are small: `boxsh-core` (storage primitives — **zero dependencies, enforced**; see its Cargo.toml), `boxsh-utils` (command support), `boxsh-abi` (cdylib exporting the versioned ABI: `boxsh_abi_version`/`boxsh_alloc`/`boxsh_free`).

## Constraints to respect

- The `wasm-opt` levels in `scripts/build-engine.mjs` (`-Oz` cold, `-O3` hot) were chosen by measurement; the comments record regressions from "upgrading" them. Don't change without re-benchmarking.
- CI (`.github/workflows/ci.yml`) enforces a 3 MiB gzip size budget on the `boxsh-abi` artifact and runs the workspace unit tests on `wasm32-wasip1` as well as native.
- Binary data stays bytes across public APIs (`stdoutBytes` alongside `stdout`, etc.).
- User-facing docs live in `docs/` at the repo root; `prepack` copies them into the package tarball (`scripts/sync-docs.mjs`) — edit them at the root, not in `packages/boxsh/docs/`.
- From CONTRIBUTING: keep implementation rationale in code comments/tests/contributor docs rather than user-facing errors and output; keep errors actionable without exposing internal state.
